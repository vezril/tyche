import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { LightMyRequestResponse } from 'light-my-request';
import { CSRF_HEADER } from '@ynab-clone/shared';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedSystemCategories } from '../../src/db/seed.js';
import { buildApp, type AppOptions } from '../../src/web/app.js';

/**
 * Shared API-test rig (E2): migrated DB + app + an authenticated session,
 * mirroring the per-file setup the E1 tests use inline.
 */

export interface TestRig {
  app: FastifyInstance;
  db: Database.Database;
  /** Temp directory holding the SQLite files — for NFR-3 raw-bytes scans. */
  dir: string;
  /** Authenticated session cookie + CSRF header, ready to spread into inject headers. */
  authed: { cookie: string; [CSRF_HEADER]: string };
  /** app.inject with the auth headers pre-applied. */
  inject(opts: InjectOptions): Promise<LightMyRequestResponse>;
  cleanup(): Promise<void>;
}

/** Extra buildApp options (E5: masterKey + injected fake Plaid factory, NFR-3 logSink). */
export type TestRigOptions = Partial<Omit<AppOptions, 'db' | 'version'>>;

export async function createTestRig(options: TestRigOptions = {}): Promise<TestRig> {
  const dir = mkdtempSync(join(tmpdir(), 'ynab-e2-'));
  const db = openDatabase(join(dir, 'app.db'));
  runMigrations(db);
  seedSystemCategories(db);
  const app = buildApp({ db, version: '0.1.0-test', ...options });
  await app.ready();

  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { [CSRF_HEADER]: '1' },
    payload: { password: 'test-password-123' },
  });
  const sid = setup.cookies.find((c) => c.name === 'sid');
  const authed = { cookie: `sid=${sid!.value}`, [CSRF_HEADER]: '1' };

  return {
    app,
    db,
    dir,
    authed,
    inject: (opts) =>
      app.inject({ ...opts, headers: { ...authed, ...(opts.headers as object | undefined) } }),
    cleanup: async () => {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
