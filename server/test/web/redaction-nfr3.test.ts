import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CSRF_HEADER } from '@tyche/shared';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedSystemCategories } from '../../src/db/seed.js';
import { loadMasterKey } from '../../src/crypto/index.js';
import { buildApp } from '../../src/web/app.js';

// NFR-3 / AC-2 / AC-3 (ADR-007): after a Plaid secret is saved, neither the
// raw SQLite files nor any log output produced along the way may contain the
// plaintext secret or the master key. The logger's redaction layer censors
// secret-bearing fields even on error paths.

const MASTER_KEY_HEX = 'e'.repeat(64);
const masterKey = loadMasterKey({ MASTER_KEY: MASTER_KEY_HEX });
const FAKE_SECRET = 'plaid-sandbox-secret-d2c1f0aa55ee77';
const PASSWORD = 'test-password-123';

describe('NFR-3: secrets at rest and in logs', () => {
  let dir: string;
  let app: FastifyInstance;
  let logLines: string[];
  let authed: { cookie: string; [CSRF_HEADER]: string };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tyche-nfr3-'));
    const db = openDatabase(join(dir, 'app.db'));
    runMigrations(db);
    seedSystemCategories(db);
    logLines = [];
    app = buildApp({
      db,
      version: '0.1.0-test',
      masterKey,
      logSink: {
        write: (line: string) => {
          logLines.push(line);
          return true;
        },
      },
    });
    await app.ready();
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { [CSRF_HEADER]: '1' },
      payload: { password: PASSWORD },
    });
    const sid = setup.cookies.find((c) => c.name === 'sid');
    authed = { cookie: `sid=${sid!.value}`, [CSRF_HEADER]: '1' };
  });
  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function exerciseSecretPaths(): Promise<void> {
    // Happy path: save, replace, read status.
    await app.inject({
      method: 'PUT',
      url: '/api/settings/plaid',
      headers: authed,
      payload: { clientId: 'client-abc', secret: FAKE_SECRET },
    });
    await app.inject({
      method: 'PUT',
      url: '/api/settings/plaid',
      headers: authed,
      payload: { clientId: 'client-abc', secret: FAKE_SECRET },
    });
    await app.inject({ method: 'GET', url: '/api/settings', headers: authed });
    // Error paths that carry secret material in the request body.
    await app.inject({
      method: 'PUT',
      url: '/api/settings/plaid',
      headers: authed,
      payload: { clientId: '', secret: FAKE_SECRET }, // 400 schema failure
    });
    await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: authed,
      payload: { currentPassword: FAKE_SECRET, newPassword: 'whatever-new-pass' }, // 401
    });
  }

  it('the raw SQLite files contain ciphertext only — never the plaintext secret or the master key (AC-2)', async () => {
    await exerciseSecretPaths();

    // Force everything to disk, then scan every on-disk artifact byte-for-byte.
    for (const suffix of ['', '-wal', '-shm']) {
      const file = join(dir, `app.db${suffix}`);
      if (!existsSync(file)) continue;
      const bytes = readFileSync(file).toString('latin1');
      expect(bytes, `plaintext secret found in app.db${suffix}`).not.toContain(FAKE_SECRET);
      expect(bytes, `master key found in app.db${suffix}`).not.toContain(MASTER_KEY_HEX);
    }
    // But the ciphertext envelope IS there (we encrypted, not dropped, the value).
    const all = ['', '-wal']
      .map((s) => join(dir, `app.db${s}`))
      .filter(existsSync)
      .map((f) => readFileSync(f).toString('latin1'))
      .join('');
    expect(all).toContain('v1.');
  });

  it('no log output produced during save/use/error paths contains secret material (AC-3)', async () => {
    await exerciseSecretPaths();
    const logs = logLines.join('');
    expect(logs.length).toBeGreaterThan(0); // logging was actually on
    expect(logs).not.toContain(FAKE_SECRET);
    expect(logs).not.toContain(MASTER_KEY_HEX);
    expect(logs).not.toContain(PASSWORD);
  });

  it("the logger's redaction layer censors secret-bearing fields explicitly logged (AC-3)", async () => {
    app.log.info(
      {
        secret: FAKE_SECRET,
        password: PASSWORD,
        body: { clientSecret: FAKE_SECRET, newPassword: PASSWORD, accessToken: FAKE_SECRET },
      },
      'settings saved',
    );
    const logs = logLines.join('');
    expect(logs).toContain('[redacted]');
    expect(logs).not.toContain(FAKE_SECRET);
    expect(logs).not.toContain(PASSWORD);
  });

  it('session cookies are redacted from request logs', async () => {
    await app.inject({ method: 'GET', url: '/api/settings', headers: authed });
    const sid = authed.cookie.slice('sid='.length);
    expect(logLines.join('')).not.toContain(sid);
  });
});
