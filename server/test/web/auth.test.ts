import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { CSRF_HEADER } from '@ynab-clone/shared';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedSystemCategories } from '../../src/db/seed.js';
import { buildApp } from '../../src/web/app.js';
import { IDLE_EXPIRY_SETTING_KEY } from '../../src/auth/sessions.js';
import { setSetting } from '../../src/admin/settings.js';

// E1.S2 integration tests: the session wall (AC-2), first-run setup (AC-1),
// cookie attributes + idle expiry (AC-3), lockout (AC-4), CSRF (AC-6).

const PASSWORD = 'correct-horse-battery';
const DAY_MS = 24 * 60 * 60 * 1000;
const CSRF = { [CSRF_HEADER]: '1' };

describe('auth over HTTP', () => {
  let dir: string;
  let db: Database.Database;
  let app: FastifyInstance;
  let nowMs: number;

  const now = (): Date => new Date(nowMs);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ynab-auth-'));
    nowMs = Date.parse('2026-06-12T00:00:00.000Z');
    db = openDatabase(join(dir, 'app.db'));
    runMigrations(db);
    seedSystemCategories(db);
    app = buildApp({ db, version: '0.1.0-test', now });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function setup(of: FastifyInstance = app, password = PASSWORD): Promise<string> {
    const res = await of.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: CSRF,
      payload: { password },
    });
    expect(res.statusCode).toBe(200);
    const sid = res.cookies.find((c) => c.name === 'sid');
    expect(sid).toBeDefined();
    return `sid=${sid!.value}`;
  }

  async function login(password: string): Promise<ReturnType<FastifyInstance['inject']>> {
    return app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: CSRF,
      payload: { password },
    });
  }

  describe('the session wall (AC-2)', () => {
    it('unauthenticated GET /api/settings/:key → 401, no data in the body', async () => {
      setSetting(db, 'some-key', 'budget-data');
      const res = await app.inject({ method: 'GET', url: '/api/settings/some-key' });
      expect(res.statusCode).toBe(401);
      expect(res.body).not.toContain('budget-data');
      expect(res.json()).toEqual({ error: 'unauthorized' });
    });

    it('unauthenticated GET /api/version → 401 (every /api route is walled)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/version' });
      expect(res.statusCode).toBe(401);
    });

    it('a garbage session cookie is rejected', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/version',
        headers: { cookie: 'sid=forged-session-id' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('/api/health stays open (allowlisted)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(200);
    });

    it('/api/auth/status stays open so the SPA can route to setup/login', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/auth/status' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ setupRequired: true, authenticated: false });
    });
  });

  describe('first-run setup (AC-1)', () => {
    it('creates the single account and logs in (session cookie set)', async () => {
      const cookie = await setup();
      const res = await app.inject({
        method: 'GET',
        url: '/api/version',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
    });

    it('setup is permanently unavailable once an account exists → 410', async () => {
      await setup();
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        headers: CSRF,
        payload: { password: 'another-password' },
      });
      expect(res.statusCode).toBe(410);
    });

    it('rejects a too-short password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        headers: CSRF,
        payload: { password: 'short' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('status flips after setup', async () => {
      const cookie = await setup();
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/status',
        headers: { cookie },
      });
      expect(res.json()).toEqual({ setupRequired: false, authenticated: true });
    });
  });

  describe('login & cookie attributes (AC-3)', () => {
    it('valid credentials set an HttpOnly SameSite=Lax cookie with an opaque id', async () => {
      await setup();
      const res = await login(PASSWORD);
      expect(res.statusCode).toBe(200);
      const sid = res.cookies.find((c) => c.name === 'sid');
      expect(sid).toBeDefined();
      expect(sid!.httpOnly).toBe(true);
      expect(sid!.sameSite).toBe('Lax');
      expect(sid!.value.length).toBeGreaterThanOrEqual(32);
      // opaque: no user data in the cookie value
      expect(sid!.value).not.toContain(PASSWORD);
    });

    it('wrong password → 401 and no cookie', async () => {
      await setup();
      const res = await login('wrong-password');
      expect(res.statusCode).toBe(401);
      expect(res.cookies.find((c) => c.name === 'sid')).toBeUndefined();
    });

    it('the session record is stored in SQLite', async () => {
      await setup();
      const res = await login(PASSWORD);
      const sid = res.cookies.find((c) => c.name === 'sid')!;
      const row = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sid.value);
      expect(row).toBeDefined();
    });

    it('the session survives a server restart (SQLite-backed)', async () => {
      const cookie = await setup();
      await app.close();
      db.close();
      // new process: fresh connection, fresh Fastify instance, same file
      db = openDatabase(join(dir, 'app.db'));
      runMigrations(db);
      app = buildApp({ db, version: '0.1.0-test', now });
      await app.ready();
      const res = await app.inject({ method: 'GET', url: '/api/version', headers: { cookie } });
      expect(res.statusCode).toBe(200);
    });

    it('idle expiry honors the configured setting (AC-3, fake clock)', async () => {
      const cookie = await setup();
      setSetting(db, IDLE_EXPIRY_SETTING_KEY, '1');
      nowMs += 2 * DAY_MS; // idle for 2 days against a 1-day window
      const res = await app.inject({ method: 'GET', url: '/api/version', headers: { cookie } });
      expect(res.statusCode).toBe(401);
    });

    it('a session within the default 30-day idle window stays valid', async () => {
      const cookie = await setup();
      nowMs += 29 * DAY_MS;
      const res = await app.inject({ method: 'GET', url: '/api/version', headers: { cookie } });
      expect(res.statusCode).toBe(200);
    });

    it('a session idle past the default 30 days expires', async () => {
      const cookie = await setup();
      nowMs += 31 * DAY_MS;
      const res = await app.inject({ method: 'GET', url: '/api/version', headers: { cookie } });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('lockout (AC-4)', () => {
    it('5 wrong passwords lock the 6th attempt out even with the right password', async () => {
      await setup();
      for (let i = 0; i < 5; i++) {
        const res = await login('wrong-password');
        expect(res.statusCode).toBe(401);
      }
      const locked = await login(PASSWORD); // correct, but locked
      expect(locked.statusCode).toBe(429);
      expect(locked.headers['retry-after']).toBeDefined();
    });

    it('the lockout lifts after 60 seconds', async () => {
      await setup();
      for (let i = 0; i < 5; i++) await login('wrong-password');
      nowMs += 61_000;
      const res = await login(PASSWORD);
      expect(res.statusCode).toBe(200);
    });

    it('a successful login resets the failure count', async () => {
      await setup();
      for (let i = 0; i < 4; i++) await login('wrong-password');
      expect((await login(PASSWORD)).statusCode).toBe(200);
      // count reset: one more failure does not lock
      await login('wrong-password');
      expect((await login(PASSWORD)).statusCode).toBe(200);
    });
  });

  describe('CSRF: SameSite + custom header on mutations (AC-6)', () => {
    it('a mutation without the custom header is rejected even with a valid session', async () => {
      const cookie = await setup();
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/k',
        headers: { cookie }, // no CSRF header
        payload: { value: 'v' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('the same mutation with the header succeeds', async () => {
      const cookie = await setup();
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/k',
        headers: { cookie, ...CSRF },
        payload: { value: 'v' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('login itself requires the header (it is a mutation)', async () => {
      await setup();
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: PASSWORD },
      });
      expect(res.statusCode).toBe(403);
    });

    it('GET requests do not require the header', async () => {
      const cookie = await setup();
      const res = await app.inject({ method: 'GET', url: '/api/version', headers: { cookie } });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('logout', () => {
    it('invalidates the server-side session row', async () => {
      const cookie = await setup();
      const out = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie, ...CSRF },
      });
      expect(out.statusCode).toBe(200);
      expect(db.prepare('SELECT id FROM sessions').all()).toHaveLength(0);
      const after = await app.inject({ method: 'GET', url: '/api/version', headers: { cookie } });
      expect(after.statusCode).toBe(401);
    });

    it('requires a session (it sits behind the wall)', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: CSRF });
      expect(res.statusCode).toBe(401);
    });
  });
});
