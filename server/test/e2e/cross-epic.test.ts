import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CSRF_HEADER,
  type AccountResponse,
  type BudgetMonthResponse,
  type ImportFileResponse,
  type PlaidItemResponse,
  type PlaidSyncRunResponse,
  type ReconcileAccountResponse,
  type RegisterResponse,
  type ReviewQueueResponse,
  type TransactionMutationResponse,
} from '@ynab-clone/shared';
import { loadMasterKey } from '../../src/crypto/index.js';
import { runConsistencyCheck } from '../../src/budget/index.js';
import { INFLOW_READY_TO_ASSIGN_CATEGORY_ID } from '../../src/db/seed.js';
import {
  PlaidApiError,
  type PlaidClientPort,
  type PlaidSyncPage,
  type PlaidTransactionData,
} from '../../src/importing/index.js';
import { createBackup, restoreBackup } from '../../src/admin/backup.js';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { computeBudget } from '../../src/budget/engine.js';
import { loadEngineInputs } from '../../src/budget/queries.js';
import { accountBalances } from '../../src/ledger/index.js';
import { createTestRig, type TestRig } from '../web/helpers.js';

/**
 * QA GATE — cross-epic end-to-end probes (qa-test-architect, execution-grounded).
 *
 * Each probe is one flow that crosses a SEAM no single epic's suite exercises
 * end to end. These are integration tests through the real HTTP app (app.inject)
 * with the real budget engine, the real SQLite store, and a fake PlaidClientPort
 * injected at the same factory seam the E5 suite uses. They assert FR
 * "Verified-by" consequences across module boundaries.
 */

const MASTER_KEY = loadMasterKey({ MASTER_KEY: 'f'.repeat(64) });

const RBC_CSV = [
  'Account Type,Account Number,Transaction Date,Cheque Number,Description 1,Description 2,CAD$,USD$',
  'Chequing,1234,6/5/2026,,LOBLAWS 1034,,-431.00,',
  'Chequing,1234,6/7/2026,,TIM HORTONS,,-5.25,',
].join('\n');

function categoryRow(payload: BudgetMonthResponse, categoryId: string) {
  const row = payload.groups.flatMap((g) => g.categories).find((c) => c.categoryId === categoryId);
  expect(row, `category ${categoryId} in payload`).toBeDefined();
  return row!;
}

// --- A fake Plaid client mirroring the E5 idiom -------------------------------

interface ScriptStep {
  page?: PlaidSyncPage;
  error?: Error;
}

class FakePlaidClient implements PlaidClientPort {
  private script: ScriptStep[] = [];
  queue(...steps: ScriptStep[]): void {
    this.script.push(...steps);
  }
  async createLinkToken(): Promise<string> {
    return 'link-token';
  }
  async createUpdateLinkToken(): Promise<string> {
    return 'update-link-token';
  }
  async exchangePublicToken(): Promise<{ accessToken: string; plaidItemId: string }> {
    return { accessToken: 'access-sandbox-token', plaidItemId: 'item-rbc-1' };
  }
  async getItemAccounts(): Promise<{
    institutionName: string;
    accounts: { plaidAccountId: string; name: string; mask: null; type: string; subtype: null }[];
  }> {
    return {
      institutionName: 'RBC Royal Bank',
      accounts: [
        { plaidAccountId: 'pa-chq', name: 'RBC Chequing', mask: null, type: 'depository', subtype: null },
      ],
    };
  }
  async transactionsSync(_token: string, cursor: string | null): Promise<PlaidSyncPage> {
    const step = this.script.shift();
    if (!step) throw new Error('fake Plaid client: script exhausted');
    if (step.error) throw step.error;
    void cursor;
    return step.page!;
  }
  async removeItem(): Promise<void> {}
}

function plaidTxn(transactionId: string, over: Partial<PlaidTransactionData> = {}): PlaidTransactionData {
  return {
    transactionId,
    plaidAccountId: 'pa-chq',
    date: '2026-06-05',
    name: 'LOBLAWS 1034',
    amount: '431.00', // Plaid sign convention: positive = outflow
    pending: false,
    raw: { transaction_id: transactionId },
    ...over,
  };
}

function syncPage(over: Partial<PlaidSyncPage> = {}): PlaidSyncPage {
  return { added: [], modified: [], removed: [], nextCursor: 'c1', hasMore: false, ...over };
}

// =============================================================================
// Probe 1 — file-import → review/approve → budget activity → rollover → RTA
//   Seam: E4 (import) + E2 (ledger/approve) + E3 (budget engine, rollover).
// =============================================================================

describe('PROBE 1: import → approve → budget activity → month rollover → RTA (E4+E2+E3)', () => {
  let rig: TestRig;
  let account: AccountResponse;
  let groceriesId: string;

  beforeEach(async () => {
    rig = await createTestRig();
    account = (
      await rig.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'Chequing', type: 'chequing', startingBalance: '0.00', startingDate: '2026-01-01' },
      })
    ).json() as AccountResponse;
    groceriesId = 'cat-groceries';
    rig.db.prepare("INSERT INTO category_groups (id, name, sort_order) VALUES ('g1', 'Everyday', 1)").run();
    rig.db.prepare("INSERT INTO categories (id, group_id, name) VALUES (?, 'g1', 'Groceries')").run(groceriesId);
  });
  afterEach(() => rig.cleanup());

  async function getMonth(month: string): Promise<BudgetMonthResponse> {
    return (await rig.inject({ method: 'GET', url: `/api/budget/${month}` })).json() as BudgetMonthResponse;
  }

  it('an imported, approved overspend flows into activity, resets to $0 next month, and deducts from next RTA', async () => {
    // 1. Income lands in June and is assigned (E2 + E3). Manual income to RTA.
    await rig.inject({
      method: 'POST',
      url: '/api/transactions',
      payload: {
        accountId: account.id,
        date: '2026-06-01',
        amount: '1000.00',
        payeeName: 'Employer',
        categoryId: INFLOW_READY_TO_ASSIGN_CATEGORY_ID,
      },
    });
    await rig.inject({
      method: 'PUT',
      url: '/api/budget/2026-06/categories/' + groceriesId,
      payload: { assigned: '400.00' },
    });

    const juneAfterAssign = await getMonth('2026-06');
    expect(juneAfterAssign.rtaMilliunits).toBe(600_000); // 1000 in − 400 assigned

    // 2. Import an RBC CSV — a $431 grocery run lands UNAPPROVED (E4).
    const { payload, headers } = multipart('rbc.csv', RBC_CSV);
    const importRes = await rig.inject({
      method: 'POST',
      url: `/api/accounts/${account.id}/import`,
      payload,
      headers,
    });
    expect(importRes.statusCode).toBe(201);
    expect((importRes.json() as ImportFileResponse).createdCount).toBe(2);

    // Before approval, the imported rows are uncategorized → no Groceries activity yet.
    const beforeApprove = categoryRow(await getMonth('2026-06'), groceriesId);
    expect(beforeApprove.activityMilliunits).toBe(0);

    // 3. Approve the Loblaws row INTO Groceries (E2 review/approve → E4 pipeline).
    const queue = (await rig.inject({ method: 'GET', url: '/api/review' })).json() as ReviewQueueResponse;
    const loblaws = queue.items.find((i) => i.transaction.payeeName === 'LOBLAWS 1034')!;
    expect(loblaws).toBeDefined();
    await rig.inject({
      method: 'POST',
      url: `/api/transactions/${loblaws.transaction.id}/approve`,
      payload: { categoryId: groceriesId },
    });

    // 4. Budget activity now reflects the approved import; Groceries is overspent.
    const june = categoryRow(await getMonth('2026-06'), groceriesId);
    expect(june.activityMilliunits).toBe(-431_000);
    expect(june.availableMilliunits).toBe(400_000 - 431_000); // −31_000, overspent

    // 5. Month rollover (E3, AS-1): July carryover is $0 (negative does not carry),
    //    and July RTA is exactly $31 lower than June's leftover would imply.
    const july = await getMonth('2026-07');
    expect(categoryRow(july, groceriesId).carryoverMilliunits).toBe(0);
    expect(july.overspendDeductedMilliunits).toBe(31_000);
    // June RTA was 600_000; July inherits it minus the overspend deduction.
    expect(july.rtaMilliunits).toBe(600_000 - 31_000);

    // 6. The whole chain is internally consistent (NFR-12 across the seam).
    expect(runConsistencyCheck(rig.db, '2026-07').ok).toBe(true);
  });
});

// =============================================================================
// Probe 2 — Plaid sync (fake) staging a row that duplicate-matches a manual
//   entry → approve → reconcile the account.
//   Seam: E5 (sync) + E4 (dedup/merge) + E2 (reconcile).
// =============================================================================

describe('PROBE 2: plaid sync dedup-matches a manual entry → approve → reconcile (E5+E4+E2)', () => {
  let rig: TestRig;
  let fake: FakePlaidClient;
  let chequing: AccountResponse;
  let itemId: string;

  beforeEach(async () => {
    fake = new FakePlaidClient();
    rig = await createTestRig({ masterKey: MASTER_KEY, plaidClientFactory: () => fake });
    chequing = (
      await rig.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'Chequing', type: 'chequing', startingBalance: '0.00', startingDate: '2026-01-01' },
      })
    ).json() as AccountResponse;
    await rig.inject({
      method: 'PUT',
      url: '/api/settings/plaid',
      payload: { clientId: 'client-abc', secret: 'plaid-secret-xyz' },
    });
    const item = (
      await rig.inject({ method: 'POST', url: '/api/plaid/items', payload: { publicToken: 'pt-1' } })
    ).json() as PlaidItemResponse;
    itemId = item.id;
    await rig.inject({
      method: 'PUT',
      url: `/api/plaid/items/${itemId}/mappings`,
      payload: { mappings: [{ plaidAccountId: 'pa-chq', accountId: chequing.id, skipped: false }] },
    });
  });
  afterEach(() => rig.cleanup());

  async function register(): Promise<RegisterResponse> {
    return (
      await rig.inject({ method: 'GET', url: `/api/accounts/${chequing.id}/transactions?limit=100` })
    ).json() as RegisterResponse;
  }

  it('the synced bank copy merges into the manual entry (one row), then reconciles to the bank balance', async () => {
    // 1. Calvin types a $431 grocery run manually (E2) before sync runs.
    const manual = (
      await rig.inject({
        method: 'POST',
        url: '/api/transactions',
        payload: {
          accountId: chequing.id,
          date: '2026-06-03',
          amount: '-431.00',
          payeeName: 'Groceries run',
          memo: 'my own note',
        },
      })
    ).json() as TransactionMutationResponse;

    // 2. A Plaid sync stages the SAME purchase (E5 → E4 three-tier matcher).
    fake.queue({ page: syncPage({ added: [plaidTxn('plaid-1', { date: '2026-06-05' })] }) });
    const sync = (
      await rig.inject({ method: 'POST', url: `/api/plaid/items/${itemId}/sync` })
    ).json() as PlaidSyncRunResponse;
    expect(sync.addedCount).toBe(0); // not a new row…
    expect(sync.mergedCount).toBe(1); // …merged into the manual entry (FR-23)

    // 3. Exactly ONE register row (plus starting balance); user data preserved,
    //    bank identity attached, dropped back to unapproved for review.
    const afterSync = await register();
    const nonStarting = afterSync.transactions.filter((t) => t.payeeName !== 'Starting Balance');
    expect(nonStarting).toHaveLength(1);
    expect(nonStarting[0]).toMatchObject({
      id: manual.transaction.id,
      memo: 'my own note',
      status: 'cleared',
      approved: false,
    });

    // 4. Approve it (E2/E4 review), then reconcile the account (E2).
    await rig.inject({
      method: 'POST',
      url: `/api/transactions/${manual.transaction.id}/approve`,
      payload: {},
    });
    const reconcile = (
      await rig.inject({
        method: 'POST',
        url: `/api/accounts/${chequing.id}/reconcile`,
        payload: { bankBalance: '-431.00' }, // bank agrees: 0 start − 431
      })
    ).json() as ReconcileAccountResponse;
    expect(reconcile.adjustmentTransaction).toBeNull(); // no discrepancy — dedup worked
    expect(reconcile.accountBalances[0]?.clearedBalanceMilliunits).toBe(-431_000);

    // 5. Consistency holds across the E5→E4→E2 seam.
    expect(runConsistencyCheck(rig.db, '2026-06').ok).toBe(true);
  });
});

// =============================================================================
// Probe 3 — migration fixture → then file-import an OVERLAPPING RBC CSV →
//   zero duplicates.
//   Seam: E6 (migration) + E4 (file import + dedup).
// =============================================================================

describe('PROBE 3: migrate, then import an overlapping RBC CSV → zero dupes (E6+E4)', () => {
  let rig: TestRig;

  beforeEach(async () => {
    rig = await createTestRig();
  });
  afterEach(() => rig.cleanup());

  it('a manual/migrated row in the same period merges with the file import instead of duplicating', async () => {
    // Stand in for "migration produced this account + a row" — the seam under
    // test is dedup against EXISTING register history regardless of provenance
    // (FR-25). Create an account and a row dated in the import window.
    const account = (
      await rig.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'Chequing', type: 'chequing', startingBalance: '0.00', startingDate: '2026-01-01' },
      })
    ).json() as AccountResponse;
    // A pre-existing $431 Loblaws row, as migration would have landed it.
    await rig.inject({
      method: 'POST',
      url: '/api/transactions',
      payload: { accountId: account.id, date: '2026-06-04', amount: '-431.00', payeeName: 'Loblaws (migrated)' },
    });

    const before = (
      await rig.inject({ method: 'GET', url: `/api/accounts/${account.id}/transactions?limit=100` })
    ).json() as RegisterResponse;
    const beforeCount = before.totalCount;

    // Import an RBC CSV that OVERLAPS that purchase (same account, same amount,
    // within ±5 days). The $5.25 Tim Hortons row is genuinely new.
    const { payload, headers } = multipart('rbc.csv', RBC_CSV);
    const res = await rig.inject({
      method: 'POST',
      url: `/api/accounts/${account.id}/import`,
      payload,
      headers,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as ImportFileResponse;
    expect(body.mergedCount).toBe(1); // the Loblaws row merged (FR-23 verified-by)
    expect(body.createdCount).toBe(1); // only Tim Hortons is new

    const after = (
      await rig.inject({ method: 'GET', url: `/api/accounts/${account.id}/transactions?limit=100` })
    ).json() as RegisterResponse;
    // Net new rows = exactly one (Tim Hortons), zero duplicate Loblaws.
    expect(after.totalCount).toBe(beforeCount + 1);
    const loblaws = after.transactions.filter((t) => t.amountMilliunits === -431_000);
    expect(loblaws).toHaveLength(1);

    // A SECOND import of the same file creates nothing (idempotent across E6+E4).
    const { payload: p2, headers: h2 } = multipart('rbc.csv', RBC_CSV);
    const second = (
      await rig.inject({ method: 'POST', url: `/api/accounts/${account.id}/import`, payload: p2, headers: h2 })
    ).json() as ImportFileResponse;
    expect(second.createdCount).toBe(0);
    expect(second.mergedCount).toBe(0);
  });
});

// =============================================================================
// Probe 4 — backup → restore → consistency check passes + budget identical.
//   Seam: E7 (backup/restore) + E3 (budget engine recompute).
// =============================================================================

describe('PROBE 4: backup → restore → consistency + identical budget values (E7+E3)', () => {
  let rig: TestRig;
  let account: AccountResponse;
  const groceriesId = 'cat-groceries';

  beforeEach(async () => {
    rig = await createTestRig({ masterKey: MASTER_KEY });
    account = (
      await rig.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'Chequing', type: 'chequing', startingBalance: '500.00', startingDate: '2026-01-01' },
      })
    ).json() as AccountResponse;
    rig.db.prepare("INSERT INTO category_groups (id, name, sort_order) VALUES ('g1', 'Everyday', 1)").run();
    rig.db.prepare("INSERT INTO categories (id, group_id, name) VALUES (?, 'g1', 'Groceries')").run(groceriesId);
  });
  afterEach(() => rig.cleanup());

  it('the restored database recomputes the same RTA, available, and balances to the cent', async () => {
    // Build a realistic month through the API (E2 + E3).
    await rig.inject({
      method: 'POST',
      url: '/api/transactions',
      payload: {
        accountId: account.id,
        date: '2026-06-01',
        amount: '2000.00',
        payeeName: 'Employer',
        categoryId: INFLOW_READY_TO_ASSIGN_CATEGORY_ID,
      },
    });
    await rig.inject({
      method: 'POST',
      url: '/api/transactions',
      payload: { accountId: account.id, date: '2026-06-05', amount: '-150.00', payeeName: 'Loblaws', categoryId: groceriesId },
    });
    await rig.inject({
      method: 'PUT',
      url: `/api/budget/2026-06/categories/${groceriesId}`,
      payload: { assigned: '300.00' },
    });

    const before = {
      balance: accountBalances(rig.db, account.id),
      budget: computeBudget(loadEngineInputs(rig.db), '2026-06').get('2026-06')!,
      count: (rig.db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n,
    };

    // Backup (E7) → restore onto a fresh "host B" location.
    const backupsDir = join(rig.dir, 'backups');
    const artifact = createBackup(rig.db, { backupsDir, appVersion: '0.1.0-test' });
    const hostB = mkdtempSync(join(tmpdir(), 'ynab-e2e-hostb-'));
    try {
      const restoredPath = join(hostB, 'data', 'app.db');
      restoreBackup(artifact.artifactPath, restoredPath);
      const restored = openDatabase(restoredPath);
      expect(runMigrations(restored)).toEqual([]); // same schema → no-op

      const after = {
        balance: accountBalances(restored, account.id),
        budget: computeBudget(loadEngineInputs(restored), '2026-06').get('2026-06')!,
        count: (restored.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n,
      };
      expect(after.balance).toEqual(before.balance);
      expect(after.budget.rtaMilliunits).toBe(before.budget.rtaMilliunits);
      expect(after.budget.categories.get(groceriesId)).toEqual(before.budget.categories.get(groceriesId));
      expect(after.count).toBe(before.count);

      // The independent NFR-12 walk passes on the restored data (E7+E3+NFR-12).
      expect(runConsistencyCheck(restored, '2026-06').ok).toBe(true);
      restored.close();
    } finally {
      rmSync(hostB, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// Probe 5 — ITEM_LOGIN_REQUIRED breaks sync → relink resumes → budget intact.
//   Seam: E5 (relink state machine) + E3 (budget unaffected by sync provenance).
// =============================================================================

describe('PROBE 5: sync breaks (ITEM_LOGIN_REQUIRED) → relink → resume, budget unchanged (E5+E3)', () => {
  let rig: TestRig;
  let fake: FakePlaidClient;
  let chequing: AccountResponse;
  let itemId: string;

  beforeEach(async () => {
    fake = new FakePlaidClient();
    rig = await createTestRig({ masterKey: MASTER_KEY, plaidClientFactory: () => fake });
    chequing = (
      await rig.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'Chequing', type: 'chequing', startingBalance: '0.00', startingDate: '2026-01-01' },
      })
    ).json() as AccountResponse;
    await rig.inject({
      method: 'PUT',
      url: '/api/settings/plaid',
      payload: { clientId: 'client-abc', secret: 'plaid-secret-xyz' },
    });
    const item = (
      await rig.inject({ method: 'POST', url: '/api/plaid/items', payload: { publicToken: 'pt-1' } })
    ).json() as PlaidItemResponse;
    itemId = item.id;
    await rig.inject({
      method: 'PUT',
      url: `/api/plaid/items/${itemId}/mappings`,
      payload: { mappings: [{ plaidAccountId: 'pa-chq', accountId: chequing.id, skipped: false }] },
    });
  });
  afterEach(() => rig.cleanup());

  it('a broken connection flips to NEEDS_RELINK, relink resumes from the cursor, and imported rows reach the budget', async () => {
    // First sync succeeds and stages an income inflow categorized to RTA.
    fake.queue({
      page: syncPage({
        added: [plaidTxn('p-income', { name: 'PAYROLL', amount: '-1000.00', date: '2026-06-01' })],
      }),
    });
    const first = (
      await rig.inject({ method: 'POST', url: `/api/plaid/items/${itemId}/sync` })
    ).json() as PlaidSyncRunResponse;
    expect(first.addedCount).toBe(1);

    // Second sync hits ITEM_LOGIN_REQUIRED (E5.S4).
    fake.queue({ error: new PlaidApiError('ITEM_LOGIN_REQUIRED', 'login changed') });
    await rig.inject({ method: 'POST', url: `/api/plaid/items/${itemId}/sync` });
    const broken = (
      await rig.inject({ method: 'GET', url: '/api/plaid/items' })
    ).json() as { items: PlaidItemResponse[] };
    expect(broken.items[0]!.status).toBe('NEEDS_RELINK');

    // Relink update mode completes → back to ACTIVE, banner clears.
    const relinked = (
      await rig.inject({ method: 'POST', url: `/api/plaid/items/${itemId}/relinked` })
    ).json() as PlaidItemResponse;
    expect(relinked.status).toBe('ACTIVE');

    // Sync resumes from the preserved cursor (no re-map needed).
    fake.queue({ page: syncPage({ added: [] }) });
    await rig.inject({ method: 'POST', url: `/api/plaid/items/${itemId}/sync` });

    // The synced payroll arrived UNAPPROVED + uncategorized — correctly NOT yet
    // counted as a budget inflow (the budget only trusts a categorized row).
    const beforeApprove = (
      await rig.inject({ method: 'GET', url: '/api/budget/2026-06' })
    ).json() as BudgetMonthResponse;
    expect(beforeApprove.inflowsMilliunits).toBe(0);

    // Calvin reviews it into Ready-to-Assign (E2 review → E3 budget). Now E3
    // sees the inflow — and never knew it arrived via Plaid (FR-25).
    const queue = (await rig.inject({ method: 'GET', url: '/api/review' })).json() as ReviewQueueResponse;
    const payroll = queue.items.find((i) => i.transaction.payeeName === 'PAYROLL')!;
    expect(payroll).toBeDefined();
    await rig.inject({
      method: 'POST',
      url: `/api/transactions/${payroll.transaction.id}/approve`,
      payload: { categoryId: INFLOW_READY_TO_ASSIGN_CATEGORY_ID },
    });

    const june = (
      await rig.inject({ method: 'GET', url: '/api/budget/2026-06' })
    ).json() as BudgetMonthResponse;
    expect(june.inflowsMilliunits).toBe(1_000_000); // the synced payroll fed RTA
    expect(june.rtaMilliunits).toBe(1_000_000); // nothing assigned yet
    expect(runConsistencyCheck(rig.db, '2026-06').ok).toBe(true);
  });
});

// --- multipart helper (mirrors server/test/web/import-api.test.ts) ------------

const BOUNDARY = '----ynabE2EBoundary';
function multipart(filename: string, content: string): { payload: Buffer; headers: Record<string, string> } {
  return {
    payload: Buffer.from(
      [
        `--${BOUNDARY}`,
        `Content-Disposition: form-data; name="file"; filename="${filename}"`,
        'Content-Type: text/csv',
        '',
        content,
        `--${BOUNDARY}--`,
        '',
      ].join('\r\n'),
    ),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}`, [CSRF_HEADER]: '1' },
  };
}
