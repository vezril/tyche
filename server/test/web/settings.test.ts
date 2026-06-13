import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { CSRF_HEADER } from '@tyche/shared';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedSystemCategories } from '../../src/db/seed.js';
import { loadMasterKey } from '../../src/crypto/index.js';
import { getPlaidSecret } from '../../src/admin/plaid.js';
import { buildApp } from '../../src/web/app.js';

// E1.S3 HTTP surface: aggregate settings read, Plaid credentials (write-only
// secret), polling interval, session idle expiry (AC-7), password change (AC-5).

const masterKey = loadMasterKey({ MASTER_KEY: 'd'.repeat(64) });
const PASSWORD = 'test-password-123';

describe('settings API (E1.S3)', () => {
  let dir: string;
  let db: Database.Database;
  let app: FastifyInstance;
  let authed: { cookie: string; [CSRF_HEADER]: string };
  let clock: Date;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tyche-settings-'));
    db = openDatabase(join(dir, 'app.db'));
    runMigrations(db);
    seedSystemCategories(db);
    clock = new Date('2026-06-12T12:00:00Z');
    app = buildApp({ db, version: '0.1.0-test', masterKey, now: () => clock });
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

  it('GET /api/settings returns the defaults before anything is saved', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings', headers: authed });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      plaid: { configured: false, clientId: null },
      pollingIntervalHours: 6,
      sessionIdleExpiryDays: 30,
    });
  });

  it('GET /api/settings requires a session (behind the wall)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(401);
  });

  describe('Plaid credentials (AC-1: write-only secret)', () => {
    it('PUT saves credentials; the response and subsequent reads never contain the secret', async () => {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/settings/plaid',
        headers: authed,
        payload: { clientId: 'client-abc', secret: 'sandbox-secret-xyz' },
      });
      expect(put.statusCode).toBe(200);
      expect(put.body).not.toContain('sandbox-secret-xyz');
      expect(put.json()).toEqual({ configured: true, clientId: 'client-abc' });

      const get = await app.inject({ method: 'GET', url: '/api/settings', headers: authed });
      expect(get.body).not.toContain('sandbox-secret-xyz');
      expect(get.json().plaid).toEqual({ configured: true, clientId: 'client-abc' });

      // The secret IS recoverable server-side for the E5 Plaid client.
      expect(getPlaidSecret(db, masterKey)).toBe('sandbox-secret-xyz');
    });

    it('PUT replaces existing credentials', async () => {
      await app.inject({
        method: 'PUT',
        url: '/api/settings/plaid',
        headers: authed,
        payload: { clientId: 'old', secret: 'old-secret' },
      });
      await app.inject({
        method: 'PUT',
        url: '/api/settings/plaid',
        headers: authed,
        payload: { clientId: 'new', secret: 'new-secret' },
      });
      expect(getPlaidSecret(db, masterKey)).toBe('new-secret');
    });

    it('DELETE clears credentials', async () => {
      await app.inject({
        method: 'PUT',
        url: '/api/settings/plaid',
        headers: authed,
        payload: { clientId: 'client-abc', secret: 'sandbox-secret-xyz' },
      });
      const del = await app.inject({ method: 'DELETE', url: '/api/settings/plaid', headers: authed });
      expect(del.statusCode).toBe(200);
      expect(del.json()).toEqual({ configured: false, clientId: null });
      expect(getPlaidSecret(db, masterKey)).toBeUndefined();
    });

    it('PUT rejects empty clientId or secret', async () => {
      for (const payload of [
        { clientId: '', secret: 's3cret' },
        { clientId: 'c', secret: '' },
        { clientId: 'c' },
        { secret: 's3cret' },
      ]) {
        const res = await app.inject({
          method: 'PUT',
          url: '/api/settings/plaid',
          headers: authed,
          payload,
        });
        expect(res.statusCode).toBe(400);
      }
    });

    it('responds 503 when the app runs without a master key (test-only configuration)', async () => {
      const bare = buildApp({ db, version: '0.1.0-test', now: () => clock });
      await bare.ready();
      const res = await bare.inject({
        method: 'PUT',
        url: '/api/settings/plaid',
        headers: authed,
        payload: { clientId: 'c', secret: 's3cret' },
      });
      expect(res.statusCode).toBe(503);
      await bare.close();
    });
  });

  describe('polling interval (AC-4: stored + validated; scheduler is E5.S3)', () => {
    it('PUT persists a valid interval and GET reflects it', async () => {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/settings/polling-interval',
        headers: authed,
        payload: { hours: 12 },
      });
      expect(put.statusCode).toBe(200);
      const get = await app.inject({ method: 'GET', url: '/api/settings', headers: authed });
      expect(get.json().pollingIntervalHours).toBe(12);
    });

    it.each([0, 25, 1.5, 'six'])('rejects invalid interval %s', async (hours) => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/polling-interval',
        headers: authed,
        payload: { hours },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('session idle expiry (AC-7: setting governs E1.S2 session checks)', () => {
    it('PUT persists the day count and GET reflects it', async () => {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/settings/session-idle-expiry',
        headers: authed,
        payload: { days: 7 },
      });
      expect(put.statusCode).toBe(200);
      const get = await app.inject({ method: 'GET', url: '/api/settings', headers: authed });
      expect(get.json().sessionIdleExpiryDays).toBe(7);
    });

    it.each([0, -3, 1.5, 366])('rejects invalid day count %s', async (days) => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/session-idle-expiry',
        headers: authed,
        payload: { days },
      });
      expect(res.statusCode).toBe(400);
    });

    it('the saved value governs session expiry end-to-end', async () => {
      await app.inject({
        method: 'PUT',
        url: '/api/settings/session-idle-expiry',
        headers: authed,
        payload: { days: 1 },
      });
      // 2 days later the session has out-idled the 1-day window.
      clock = new Date('2026-06-14T12:00:01Z');
      const res = await app.inject({ method: 'GET', url: '/api/settings', headers: authed });
      expect(res.statusCode).toBe(401);
    });

    it.each(['session_idle_expiry_days', 'polling_interval_hours'])(
      'the generic KV route refuses managed key %s (no validation bypass)',
      async (key) => {
        const res = await app.inject({
          method: 'PUT',
          url: `/api/settings/${key}`,
          headers: authed,
          payload: { value: '99999' },
        });
        expect(res.statusCode).toBe(400);
        // The validated reader still sees its default, not 99999.
        const get = await app.inject({ method: 'GET', url: '/api/settings', headers: authed });
        expect(get.json().sessionIdleExpiryDays).toBe(30);
        expect(get.json().pollingIntervalHours).toBe(6);
      },
    );
  });

  describe('POST /api/auth/change-password (AC-5)', () => {
    it('requires the current password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        headers: authed,
        payload: { currentPassword: 'WRONG-password', newPassword: 'brand-new-password' },
      });
      expect(res.statusCode).toBe(401);
      // Old password still works.
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { [CSRF_HEADER]: '1' },
        payload: { password: PASSWORD },
      });
      expect(login.statusCode).toBe(200);
    });

    it('changes the password, keeps the current session, invalidates others', async () => {
      // A second session that must die.
      const other = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { [CSRF_HEADER]: '1' },
        payload: { password: PASSWORD },
      });
      const otherSid = other.cookies.find((c) => c.name === 'sid')!.value;

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        headers: authed,
        payload: { currentPassword: PASSWORD, newPassword: 'brand-new-password' },
      });
      expect(res.statusCode).toBe(200);

      // Current session survives; the other is gone.
      const mine = await app.inject({ method: 'GET', url: '/api/settings', headers: authed });
      expect(mine.statusCode).toBe(200);
      const theirs = await app.inject({
        method: 'GET',
        url: '/api/settings',
        headers: { cookie: `sid=${otherSid}` },
      });
      expect(theirs.statusCode).toBe(401);

      // New password logs in; old does not.
      const oldLogin = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { [CSRF_HEADER]: '1' },
        payload: { password: PASSWORD },
      });
      expect(oldLogin.statusCode).toBe(401);
      const newLogin = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { [CSRF_HEADER]: '1' },
        payload: { password: 'brand-new-password' },
      });
      expect(newLogin.statusCode).toBe(200);
    });

    it('enforces the same minimum length as setup for the new password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        headers: authed,
        payload: { currentPassword: PASSWORD, newPassword: 'short' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('requires the CSRF header like every mutation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        headers: { cookie: authed.cookie },
        payload: { currentPassword: PASSWORD, newPassword: 'brand-new-password' },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
