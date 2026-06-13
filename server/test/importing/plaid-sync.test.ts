import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { milliunits } from '@tyche/shared';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedSystemCategories } from '../../src/db/seed.js';
import { loadMasterKey } from '../../src/crypto/index.js';
import {
  approveTransaction,
  createAccount,
  createTransaction,
  getRegister,
  getTransaction,
} from '../../src/ledger/index.js';
import {
  applyAccountMappings,
  createLinkedItem,
  getPlaidItem,
  ImportError,
  listReviewQueue,
  listSyncLog,
  PLAID_MUTATION_ERROR,
  plaidAmountToMilliunits,
  PlaidApiError,
  REMOVED_BY_BANK_NOTE,
  syncPlaidItem,
  type PlaidClientPort,
  type PlaidSyncPage,
  type PlaidTransactionData,
} from '../../src/importing/index.js';

/**
 * The full /transactions/sync state machine (E5.S2, FR-21), driven entirely
 * through a fake PlaidClientPort — the suite never touches the network
 * (ADR-006; the real adapter is sdk.ts, exercised manually in sandbox).
 * Covers: initial full sync with has_more paging, incremental adds from the
 * stored cursor, modified→in-place update, removed→void/flag, per-page
 * transactional cursor advance (resume after mid-stream failure), and the
 * TRANSACTIONS_SYNC_MUTATION restart-from-applied-cursor loop.
 */

const masterKey = loadMasterKey({ MASTER_KEY: 'b'.repeat(64) });
const ACCESS_TOKEN = 'access-sandbox-99990000-aaaa-bbbb-cccc-ddddeeeeffff';

interface ScriptStep {
  page?: PlaidSyncPage;
  error?: Error;
}

/** Scripted fake at the PlaidClientPort seam: records cursors, plays back steps. */
class FakePlaidClient implements PlaidClientPort {
  /** The cursor of every transactionsSync call, in order. */
  cursors: (string | null)[] = [];
  private script: ScriptStep[] = [];

  queue(...steps: ScriptStep[]): void {
    this.script.push(...steps);
  }

  async createLinkToken(): Promise<string> {
    return 'link-sandbox-token';
  }
  async createUpdateLinkToken(): Promise<string> {
    return 'link-sandbox-update-token';
  }
  async removeItem(): Promise<void> {
    // not exercised here — see plaid-relink-unlink-api.test.ts (E5.S5)
  }
  async exchangePublicToken(): Promise<{ accessToken: string; plaidItemId: string }> {
    return { accessToken: ACCESS_TOKEN, plaidItemId: 'item-rbc-1' };
  }
  async getItemAccounts(): Promise<{ institutionName: string | null; accounts: [] }> {
    return { institutionName: 'RBC Royal Bank', accounts: [] };
  }
  async transactionsSync(_accessToken: string, cursor: string | null): Promise<PlaidSyncPage> {
    this.cursors.push(cursor);
    const step = this.script.shift();
    if (!step) throw new Error('fake Plaid client: script exhausted');
    if (step.error) throw step.error;
    return step.page!;
  }
}

function txn(
  transactionId: string,
  over: Partial<PlaidTransactionData> = {},
): PlaidTransactionData {
  return {
    transactionId,
    plaidAccountId: 'pa-chq',
    date: '2026-06-05',
    name: 'TIM HORTONS #2241',
    amount: '5.25', // Plaid convention: positive = outflow
    pending: false,
    raw: { transaction_id: transactionId },
    ...over,
  };
}

function page(over: Partial<PlaidSyncPage> = {}): PlaidSyncPage {
  return { added: [], modified: [], removed: [], nextCursor: 'c1', hasMore: false, ...over };
}

let db: Database.Database;
let client: FakePlaidClient;
let chequingId: string;
let itemId: string;

function register() {
  return getRegister(db, chequingId, { limit: 500 });
}

const sync = () => syncPlaidItem(db, masterKey, client, itemId);

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  seedSystemCategories(db);
  client = new FakePlaidClient();
  chequingId = createAccount(db, {
    name: 'Chequing',
    type: 'chequing',
    startingBalanceMilliunits: milliunits(0),
    startingDate: '2026-01-01',
  }).id;
  const item = createLinkedItem(db, masterKey, {
    plaidItemId: 'item-rbc-1',
    accessToken: ACCESS_TOKEN,
    institutionName: 'RBC Royal Bank',
    accounts: [
      { plaidAccountId: 'pa-chq', name: 'Chequing', mask: '1234', type: 'depository', subtype: 'checking' },
      { plaidAccountId: 'pa-skip', name: 'Visa', mask: '9999', type: 'credit', subtype: 'credit card' },
      { plaidAccountId: 'pa-pending', name: 'Savings', mask: '5678', type: 'depository', subtype: 'savings' },
    ],
  });
  itemId = item.id;
  applyAccountMappings(db, itemId, [
    { plaidAccountId: 'pa-chq', accountId: chequingId, skipped: false },
    { plaidAccountId: 'pa-skip', accountId: null, skipped: true },
    // pa-pending stays unmapped (no decision yet)
  ]);
});
afterEach(() => db.close());

describe('amount conversion (AC-1, ADR-004)', () => {
  it("parses Plaid's decimal strings to signed milliunits via the audited parser — outflows negative", () => {
    expect(plaidAmountToMilliunits('5.25')).toBe(-5250); // Plaid positive = money out
    expect(plaidAmountToMilliunits('-1432.10')).toBe(1432100); // Plaid negative = money in
    expect(plaidAmountToMilliunits('0.07')).toBe(-70);
    expect(plaidAmountToMilliunits('1000')).toBe(-1000000);
    expect(() => plaidAmountToMilliunits('not-money')).toThrow();
  });
});

describe('added transactions (AC-1, AC-4)', () => {
  it('initial full sync pages through has_more, lands unapproved+cleared rows, and persists the LAST cursor', async () => {
    client.queue(
      { page: page({ added: [txn('p-1'), txn('p-2', { amount: '-1432.10', name: 'PAYROLL' })], nextCursor: 'c1', hasMore: true }) },
      { page: page({ added: [txn('p-3', { date: '2026-06-06' })], nextCursor: 'c2' }) },
    );
    const result = await sync();
    expect(result.addedCount).toBe(3);
    expect(client.cursors).toEqual([null, 'c1']); // first sync starts from the beginning
    expect(getPlaidItem(db, itemId).cursor).toBe('c2');

    const rows = register().transactions.filter((t) => !t.isStartingBalance);
    expect(rows).toHaveLength(3);
    const payroll = rows.find((t) => t.payeeName === 'PAYROLL')!;
    expect(payroll).toMatchObject({
      amountMilliunits: 1432100,
      status: 'cleared',
      approved: false,
      source: 'plaid',
    });
    expect(
      db.prepare('SELECT import_id FROM transactions WHERE id = ?').get(payroll.id),
    ).toEqual({ import_id: 'p-2' }); // Plaid transaction_id is the external id
  });

  it('incremental sync resumes from the stored cursor and dedups redelivered rows (T1)', async () => {
    client.queue({ page: page({ added: [txn('p-1')], nextCursor: 'c1' }) });
    await sync();

    client.queue({ page: page({ added: [txn('p-1'), txn('p-9', { date: '2026-06-07' })], nextCursor: 'c2' }) });
    const second = await sync();
    expect(client.cursors).toEqual([null, 'c1']); // resumed, not restarted
    expect(second.addedCount).toBe(1);
    expect(second.duplicateCount).toBe(1);
    expect(register().transactions.filter((t) => !t.isStartingBalance)).toHaveLength(2);
  });

  it('AC-4: transactions for skipped or unmapped bank accounts are ignored', async () => {
    client.queue({
      page: page({
        added: [
          txn('p-1'),
          txn('p-skip', { plaidAccountId: 'pa-skip' }),
          txn('p-unmapped', { plaidAccountId: 'pa-pending' }),
          txn('p-unknown', { plaidAccountId: 'pa-never-discovered' }),
        ],
        nextCursor: 'c1',
      }),
    });
    const result = await sync();
    expect(result.addedCount).toBe(1);
    expect(result.ignoredUnmappedCount).toBe(3);
    expect(register().transactions.filter((t) => !t.isStartingBalance)).toHaveLength(1);
  });

  it('AC-6 (FR-25): a Plaid row meets a manual entry exactly like file import does — T2 merge, category kept', async () => {
    const manual = createTransaction(db, {
      accountId: chequingId,
      date: '2026-06-03',
      amountMilliunits: milliunits(-5250),
      payeeName: 'Tims',
      memo: 'my note',
    });
    client.queue({ page: page({ added: [txn('p-1')], nextCursor: 'c1' }) });
    const result = await sync();
    expect(result.mergedCount).toBe(1);
    expect(result.addedCount).toBe(0);
    const merged = getTransaction(db, manual.id);
    expect(merged).toMatchObject({ memo: 'my note', approved: false, status: 'cleared' });
    expect(register().transactions.filter((t) => !t.isStartingBalance)).toHaveLength(1);
  });
});

describe('modified transactions (AC-2)', () => {
  it('updates the existing row in place (matched by external id) without duplicating or discarding edits', async () => {
    client.queue({ page: page({ added: [txn('p-1', { amount: '5.25', date: '2026-06-05' })], nextCursor: 'c1' }) });
    const first = await sync();
    const rowId = first.accountIds.length > 0 ? register().transactions.find((t) => !t.isStartingBalance)!.id : '';
    // Calvin reviews it: categorize + memo + approve
    db.prepare("INSERT INTO category_groups (id, name) VALUES ('g1', 'Everyday')").run();
    db.prepare("INSERT INTO categories (id, group_id, name) VALUES ('cat-coffee', 'g1', 'Coffee')").run();
    approveTransaction(db, rowId, { categoryId: 'cat-coffee', memo: 'double double' });

    // pending → posted upstream: amount and date both move
    client.queue({
      page: page({ modified: [txn('p-1', { amount: '6.00', date: '2026-06-06' })], nextCursor: 'c2' }),
    });
    const second = await sync();
    expect(second.updatedCount).toBe(1);
    expect(second.addedCount).toBe(0);

    const rows = register().transactions.filter((t) => !t.isStartingBalance);
    expect(rows).toHaveLength(1); // updated, never duplicated
    expect(rows[0]).toMatchObject({
      id: rowId,
      amountMilliunits: -6000,
      date: '2026-06-06',
      categoryId: 'cat-coffee', // Calvin's category survives
      memo: 'double double', // Calvin's memo survives
      approved: false, // but the change resurfaces in review (FR-22)
    });
  });

  it('content-identical modified redelivery is an idempotent skip, not an update', async () => {
    client.queue({ page: page({ added: [txn('p-1')], nextCursor: 'c1' }) });
    await sync();
    const rowId = register().transactions.find((t) => !t.isStartingBalance)!.id;
    approveTransaction(db, rowId, {});

    client.queue({ page: page({ modified: [txn('p-1')], nextCursor: 'c2' }) });
    const second = await sync();
    expect(second.updatedCount).toBe(0);
    expect(second.duplicateCount).toBe(1);
    expect(getTransaction(db, rowId).approved).toBe(true); // untouched
  });
});

describe('removed transactions (AC-3)', () => {
  it('an unapproved row is voided, and the id is remembered so it never resurrects', async () => {
    client.queue({ page: page({ added: [txn('p-1')], nextCursor: 'c1' }) });
    await sync();

    client.queue({
      page: page({ removed: [{ transactionId: 'p-1', plaidAccountId: 'pa-chq' }], nextCursor: 'c2' }),
    });
    const result = await sync();
    expect(result.removedVoidedCount).toBe(1);
    expect(result.removedFlaggedCount).toBe(0);
    expect(register().transactions.filter((t) => !t.isStartingBalance)).toHaveLength(0);

    // the bank re-sending the same id later must NOT recreate the row
    client.queue({ page: page({ added: [txn('p-1')], nextCursor: 'c3' }) });
    const replay = await sync();
    expect(replay.addedCount).toBe(0);
    expect(register().transactions.filter((t) => !t.isStartingBalance)).toHaveLength(0);
  });

  it('an approved row is flagged for review with a visible note — never silently deleted', async () => {
    client.queue({ page: page({ added: [txn('p-1')], nextCursor: 'c1' }) });
    await sync();
    const rowId = register().transactions.find((t) => !t.isStartingBalance)!.id;
    approveTransaction(db, rowId, { memo: 'rent e-transfer' });

    client.queue({
      page: page({ removed: [{ transactionId: 'p-1', plaidAccountId: 'pa-chq' }], nextCursor: 'c2' }),
    });
    const result = await sync();
    expect(result.removedFlaggedCount).toBe(1);
    expect(result.removedVoidedCount).toBe(0);

    const row = getTransaction(db, rowId);
    expect(row.approved).toBe(false); // back in the review queue (FR-22)
    expect(row.memo).toContain(REMOVED_BY_BANK_NOTE);
    expect(row.memo).toContain('rent e-transfer'); // the user's memo is kept
    expect(listReviewQueue(db).some((i) => i.transaction.id === rowId)).toBe(true);

    // replaying the same removal is a no-op
    client.queue({
      page: page({ removed: [{ transactionId: 'p-1', plaidAccountId: 'pa-chq' }], nextCursor: 'c3' }),
    });
    const replay = await sync();
    expect(replay.removedFlaggedCount).toBe(0);
    expect(getTransaction(db, rowId).memo).toBe(row.memo); // note not appended twice
  });

  it('a removal without an account hint still finds the row across mapped accounts', async () => {
    client.queue({ page: page({ added: [txn('p-1')], nextCursor: 'c1' }) });
    await sync();
    client.queue({
      page: page({ removed: [{ transactionId: 'p-1', plaidAccountId: null }], nextCursor: 'c2' }),
    });
    const result = await sync();
    expect(result.removedVoidedCount).toBe(1);
  });
});

describe('cursor discipline (AC-5)', () => {
  it('a mid-stream failure leaves the cursor on the last APPLIED page; re-running resumes without loss or dupes', async () => {
    client.queue(
      { page: page({ added: [txn('p-1')], nextCursor: 'c1', hasMore: true }) },
      { error: new PlaidApiError('INTERNAL_SERVER_ERROR', 'plaid fell over') },
    );
    await expect(sync()).rejects.toThrow('plaid fell over');

    // page 1 was applied transactionally WITH its cursor; page 2 never moved it
    expect(getPlaidItem(db, itemId).cursor).toBe('c1');
    expect(register().transactions.filter((t) => !t.isStartingBalance)).toHaveLength(1);

    // retry resumes from c1 and completes
    client.queue({ page: page({ added: [txn('p-2', { date: '2026-06-08' })], nextCursor: 'c2' }) });
    const retry = await sync();
    expect(client.cursors.at(-1)).toBe('c1');
    expect(retry.addedCount).toBe(1);
    expect(retry.duplicateCount).toBe(0); // nothing redelivered, nothing lost
    expect(getPlaidItem(db, itemId).cursor).toBe('c2');
    expect(register().transactions.filter((t) => !t.isStartingBalance)).toHaveLength(2);
  });

  it('TRANSACTIONS_SYNC_MUTATION mid-pagination restarts from the stored cursor (per Plaid docs)', async () => {
    client.queue(
      { page: page({ added: [txn('p-1')], nextCursor: 'c1', hasMore: true }) },
      { error: new PlaidApiError(PLAID_MUTATION_ERROR, 'data mutated during pagination') },
      // the restart re-fetches from c1 — upstream now redelivers p-1's page sibling and the new row
      { page: page({ added: [txn('p-1'), txn('p-2', { date: '2026-06-09' })], nextCursor: 'c3' }) },
    );
    const result = await sync();
    expect(client.cursors).toEqual([null, 'c1', 'c1']); // restarted from the last APPLIED cursor
    expect(result.addedCount).toBe(2);
    expect(result.duplicateCount).toBe(1); // the redelivered p-1 was a T1 no-op
    expect(getPlaidItem(db, itemId).cursor).toBe('c3');
    expect(register().transactions.filter((t) => !t.isStartingBalance)).toHaveLength(2);
  });

  it('gives up after repeated mutation restarts instead of looping forever', async () => {
    const mutation = () => ({ error: new PlaidApiError(PLAID_MUTATION_ERROR, 'mutating forever') });
    client.queue(mutation(), mutation(), mutation(), mutation());
    await expect(sync()).rejects.toThrow(PlaidApiError);
  });
});

describe('sync-health log + state guards (AC-7)', () => {
  it('appends a success entry with counts, and an error entry carrying the Plaid code', async () => {
    client.queue({ page: page({ added: [txn('p-1')], nextCursor: 'c1' }) });
    await sync();
    client.queue({ error: new PlaidApiError('ITEM_LOGIN_REQUIRED', 'please re-link') });
    await expect(sync()).rejects.toThrow('please re-link');

    const log = listSyncLog(db, itemId);
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ outcome: 'error', errorCode: 'ITEM_LOGIN_REQUIRED' });
    expect(log[1]).toMatchObject({ outcome: 'success', addedCount: 1 });
  });

  it('refuses to sync an Item that is not ACTIVE', async () => {
    db.prepare("UPDATE plaid_items SET status = 'LINKING' WHERE id = ?").run(itemId);
    await expect(sync()).rejects.toThrow(ImportError);
    expect(client.cursors).toHaveLength(0); // never reached the network seam
  });
});

describe('lost MASTER_KEY after a restore (E7.S1 AC-3, ADR-007)', () => {
  it('an unreadable token flips the Item to NEEDS_RELINK with a logged attempt — never a crash loop', async () => {
    const wrongKey = loadMasterKey({ MASTER_KEY: 'c'.repeat(64) });
    await expect(syncPlaidItem(db, wrongKey, client, itemId)).rejects.toMatchObject({
      code: 'plaid_token_unreadable',
    });
    // The re-link path IS the recovery (re-linking stores a fresh token under
    // the current key) — exactly the accepted ADR-007 consequence, no worse.
    expect(getPlaidItem(db, itemId).status).toBe('NEEDS_RELINK');
    const log = db
      .prepare('SELECT outcome, error_code AS errorCode FROM plaid_sync_log WHERE plaid_item_id = ?')
      .all(itemId) as { outcome: string; errorCode: string | null }[];
    expect(log).toEqual([{ outcome: 'error', errorCode: 'TOKEN_DECRYPTION_FAILED' }]);
    expect(client.cursors).toEqual([]); // Plaid was never called
  });
});
