import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MigrationResponse } from '@tyche/shared';
import { CSRF_HEADER } from '@tyche/shared';
import { createTestRig, type TestRig } from './helpers.js';

/**
 * E6 over HTTP: POST /api/migration with the two YNAB export CSVs as one
 * multipart request (fields `register` + `plan`). The route is translation
 * only — refusal/parity/discrepancy semantics live in migration/ and are
 * tested there; here we pin the wire contract, the 409 empty-budget refusal,
 * and that the route sits behind the session wall like everything else.
 */

const FIXTURES = join(import.meta.dirname, '../migration/fixtures');
const REGISTER = readFileSync(join(FIXTURES, 'register.csv'), 'utf8');
const PLAN = readFileSync(join(FIXTURES, 'plan.csv'), 'utf8');

const BOUNDARY = '----tycheMigrationBoundary7';

function multipart(parts: { field: string; filename: string; content: string }[]): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const chunks: string[] = [];
  for (const part of parts) {
    chunks.push(
      `--${BOUNDARY}`,
      `content-disposition: form-data; name="${part.field}"; filename="${part.filename}"`,
      'content-type: text/csv',
      '',
      part.content,
    );
  }
  chunks.push(`--${BOUNDARY}--`, '');
  return {
    payload: Buffer.from(chunks.join('\r\n')),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  };
}

describe('POST /api/migration', () => {
  let rig: TestRig;

  beforeEach(async () => {
    rig = await createTestRig();
  });
  afterEach(() => rig.cleanup());

  function run(parts = [
    { field: 'register', filename: 'register.csv', content: REGISTER },
    { field: 'plan', filename: 'plan.csv', content: PLAN },
  ]) {
    const { payload, headers } = multipart(parts);
    return rig.inject({ method: 'POST', url: '/api/migration', payload, headers });
  }

  it('migrates the export pair and returns parity + discrepancy report (FR-30/31)', async () => {
    const res = await run();
    expect(res.statusCode).toBe(201);
    const body = res.json() as MigrationResponse;
    expect(body.accountCount).toBe(5);
    expect(body.categoryCount).toBe(30);
    expect(body.transactionCount).toBe(104);
    expect(body.assignmentCount).toBe(115);
    expect(body.parity.ok).toBe(true);
    expect(body.parity.month).toBe('2026-06');
    expect(body.parity.accounts).toHaveLength(5);
    expect(body.parity.categories).toHaveLength(30);
    expect(body.consistency.ok).toBe(true);
    expect(body.discrepancies.length).toBeGreaterThan(0);
  });

  it('refuses a second run with 409 budget_not_empty (FR-31)', async () => {
    expect((await run()).statusCode).toBe(201);
    const res = await run();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'budget_not_empty' });
  });

  it('400s when one of the two files is missing', async () => {
    const res = await run([{ field: 'register', filename: 'register.csv', content: REGISTER }]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'plan_file_required' });
  });

  it('400s a structurally wrong CSV with the parse reason', async () => {
    const res = await run([
      { field: 'register', filename: 'register.csv', content: '"Nope"\n"x"' },
      { field: 'plan', filename: 'plan.csv', content: PLAN },
    ]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_register_csv' });
  });

  it('sits behind the session wall + CSRF check', async () => {
    const { payload, headers } = multipart([
      { field: 'register', filename: 'register.csv', content: REGISTER },
      { field: 'plan', filename: 'plan.csv', content: PLAN },
    ]);
    const noCsrf = await rig.app.inject({
      method: 'POST',
      url: '/api/migration',
      payload,
      headers: { ...headers, cookie: rig.authed.cookie },
    });
    expect(noCsrf.statusCode).toBe(403);
    const noSession = await rig.app.inject({
      method: 'POST',
      url: '/api/migration',
      payload,
      headers: { ...headers, [CSRF_HEADER]: '1' },
    });
    expect(noSession.statusCode).toBe(401);
  });
});
