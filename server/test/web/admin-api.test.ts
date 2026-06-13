import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER, milliunits } from '@ynab-clone/shared';
import type {
  BackupRunResponse,
  BackupsResponse,
  BootConsistencyResponse,
  ConsistencyCheckResponse,
} from '@ynab-clone/shared';
import { INFLOW_READY_TO_ASSIGN_CATEGORY_ID } from '../../src/db/seed.js';
import { createAccount, createTransaction } from '../../src/ledger/index.js';
import { createTestRig, type TestRig } from './helpers.js';

/**
 * E7 ops endpoints (admin-routes.ts): backup (S1), CSV export (S2), the
 * NFR-12 consistency check (S4). All live behind the session wall (FR-33) —
 * S2 AC-4's "without a session they return the auth challenge" is pinned for
 * every route here.
 */

describe('ops API (E7)', () => {
  let rig: TestRig;
  let backupsDir: string;

  beforeEach(async () => {
    backupsDir = mkdtempSync(join(tmpdir(), 'ynab-e7-api-backups-'));
    rig = await createTestRig({
      backupsDir,
      bootConsistency: {
        ok: true,
        mismatches: [],
        checkedAccounts: 0,
        checkedMonths: 1,
        throughMonth: '2026-06',
        ranAt: '2026-06-12T00:00:00.000Z',
      },
    });
  });
  afterEach(async () => {
    await rig.cleanup();
    rmSync(backupsDir, { recursive: true, force: true });
  });

  function seed(): void {
    rig.db
      .prepare("INSERT INTO category_groups (id, name, sort_order) VALUES ('g1', 'Everyday', 1)")
      .run();
    rig.db
      .prepare("INSERT INTO categories (id, group_id, name) VALUES ('groceries', 'g1', 'Groceries')")
      .run();
    const account = createAccount(rig.db, {
      name: 'Chequing',
      type: 'chequing',
      startingBalanceMilliunits: milliunits(100_000),
      startingDate: '2026-01-01',
    });
    createTransaction(rig.db, {
      accountId: account.id,
      date: '2026-02-05',
      amountMilliunits: milliunits(-25_500),
      payeeName: 'Loblaws',
      categoryId: 'groceries',
      memo: '',
    });
    createTransaction(rig.db, {
      accountId: account.id,
      date: '2026-02-01',
      amountMilliunits: milliunits(500_000),
      payeeName: 'Employer',
      categoryId: INFLOW_READY_TO_ASSIGN_CATEGORY_ID,
      memo: '',
    });
  }

  it('FR-33: every ops route answers the auth challenge without a session', async () => {
    for (const [method, url] of [
      ['POST', '/api/admin/backup'],
      ['GET', '/api/admin/backups'],
      ['GET', '/api/admin/consistency'],
      ['POST', '/api/admin/consistency/run'],
      ['GET', '/api/export/register.csv'],
      ['GET', '/api/export/budget.csv'],
    ] as const) {
      const res = await rig.app.inject({ method, url, headers: { [CSRF_HEADER]: '1' } });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('S1 AC-1: POST /api/admin/backup writes one artifact; GET lists it newest first', async () => {
    seed();
    const run = await rig.inject({ method: 'POST', url: '/api/admin/backup' });
    expect(run.statusCode).toBe(200);
    const body = run.json<BackupRunResponse>();
    expect(body.artifact.name).toMatch(/^ynab-clone-backup-.*\.tar\.gz$/);
    expect(body.artifact.sizeBytes).toBeGreaterThan(0);
    expect(readdirSync(backupsDir)).toEqual([body.artifact.name]);

    const list = await rig.inject({ method: 'GET', url: '/api/admin/backups' });
    expect(list.json<BackupsResponse>().backups.map((b) => b.name)).toEqual([body.artifact.name]);
  });

  it('S4 AC-2: GET /api/admin/consistency surfaces the boot-time result', async () => {
    const res = await rig.inject({ method: 'GET', url: '/api/admin/consistency' });
    const body = res.json<BootConsistencyResponse>();
    expect(body.boot?.ok).toBe(true);
    expect(body.boot?.ranAt).toBe('2026-06-12T00:00:00.000Z');
  });

  it('S4 AC-3: on-demand check returns a pass within the request', async () => {
    seed();
    const res = await rig.inject({ method: 'POST', url: '/api/admin/consistency/run' });
    expect(res.statusCode).toBe(200);
    const report = res.json<ConsistencyCheckResponse>();
    expect(report.ok).toBe(true);
    expect(report.mismatches).toEqual([]);
    expect(report.checkedAccounts).toBe(1);
    expect(report.throughMonth).toMatch(/^\d{4}-\d{2}$/);
  });

  it('S4 AC-5: a corrupted raw row turns the on-demand check red, with the entity named', async () => {
    seed();
    // Corrupt: make the transfer-free dataset inconsistent by splitting a row
    // by hand and tampering the line sum (the FR-15 invariant).
    const parent = rig.db
      .prepare("SELECT id, account_id AS accountId FROM transactions WHERE amount_milliunits = -25500")
      .get() as { id: string; accountId: string };
    rig.db
      .prepare(
        `INSERT INTO transactions (id, account_id, date, amount_milliunits, category_id, parent_id, memo)
         VALUES ('bad-line', ?, '2026-02-05', -20000, 'groceries', ?, '')`,
      )
      .run(parent.accountId, parent.id);

    const res = await rig.inject({ method: 'POST', url: '/api/admin/consistency/run' });
    const report = res.json<ConsistencyCheckResponse>();
    expect(report.ok).toBe(false);
    expect(report.mismatches.join('\n')).toContain(`split parent ${parent.id}`);
  });

  it('S2 AC-4: register CSV streams back curl-style with a session', async () => {
    seed();
    const res = await rig.inject({ method: 'GET', url: '/api/export/register.csv' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('register.csv');
    const lines = res.body.trim().split('\n');
    expect(lines[0]).toContain('Account');
    expect(lines).toHaveLength(4); // header + starting balance + 2 transactions
    expect(res.body).toContain('-25.50');
  });

  it('S2 AC-4: budget CSV streams back too', async () => {
    seed();
    const res = await rig.inject({ method: 'GET', url: '/api/export/budget.csv' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body.split('\n')[0]).toContain('Month');
    expect(res.body).toContain('Groceries');
  });

  it('without an explicit option, backups default to backups/ beside the database file', async () => {
    const bare = await createTestRig();
    try {
      const run = await bare.inject({ method: 'POST', url: '/api/admin/backup' });
      expect(run.statusCode).toBe(200);
      expect(readdirSync(join(bare.dir, 'backups'))).toHaveLength(1);
    } finally {
      await bare.cleanup();
    }
  });
});
