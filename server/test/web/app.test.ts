import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '@ynab-clone/shared';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedSystemCategories } from '../../src/db/seed.js';
import { buildApp } from '../../src/web/app.js';
import type { FastifyInstance } from 'fastify';

// E1.S1 HTTP surface: health, version, and the AC-3 placeholder settings write.
// Since E1.S2 every /api route except the allowlist requires a session, so this
// suite authenticates up front (the session wall itself is tested in auth.test.ts).

describe('web app', () => {
  let dir: string;
  let app: FastifyInstance;
  let authed: { cookie: string; [CSRF_HEADER]: string };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ynab-app-'));
    const db = openDatabase(join(dir, 'app.db'));
    runMigrations(db);
    seedSystemCategories(db);
    app = buildApp({ db, version: '0.1.0-test' });
    await app.ready();
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { [CSRF_HEADER]: '1' },
      payload: { password: 'test-password-123' },
    });
    const sid = setup.cookies.find((c) => c.name === 'sid');
    authed = { cookie: `sid=${sid!.value}`, [CSRF_HEADER]: '1' };
  });
  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('GET /api/health reports ok and verifies the database', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', database: 'ok' });
  });

  it('GET /api/version reports the app version', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/version', headers: authed });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ version: '0.1.0-test' });
  });

  it('PUT then GET /api/settings/:key round-trips a value (AC-3 placeholder write)', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings/durability-probe',
      headers: authed,
      payload: { value: 'written-before-kill' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ key: 'durability-probe', value: 'written-before-kill' });

    const get = await app.inject({
      method: 'GET',
      url: '/api/settings/durability-probe',
      headers: authed,
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ key: 'durability-probe', value: 'written-before-kill' });
  });

  it('PUT /api/settings/:key upserts on repeat writes', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/settings/k',
      headers: authed,
      payload: { value: 'v1' },
    });
    await app.inject({
      method: 'PUT',
      url: '/api/settings/k',
      headers: authed,
      payload: { value: 'v2' },
    });
    const get = await app.inject({ method: 'GET', url: '/api/settings/k', headers: authed });
    expect(get.json()).toEqual({ key: 'k', value: 'v2' });
  });

  it('GET /api/settings/:key returns 404 for unknown keys', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings/nope', headers: authed });
    expect(res.statusCode).toBe(404);
  });

  it('PUT /api/settings/:key rejects a missing value (schema-validated route)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/k',
      headers: authed,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('unknown /api routes 404 as JSON, not the SPA fallback', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/does-not-exist',
      headers: authed,
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('unknown /api routes are 401 when unauthenticated (wall before routing)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(res.statusCode).toBe(401);
  });
});
