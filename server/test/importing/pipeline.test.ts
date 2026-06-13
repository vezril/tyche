import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { milliunits, type Milliunits } from '@ynab-clone/shared';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedSystemCategories } from '../../src/db/seed.js';
import {
  createAccount,
  createTransaction,
  getRegister,
  getTransaction,
} from '../../src/ledger/index.js';
import {
  parseOfx,
  parseRbcCsv,
  rejectTransaction,
  runImport,
  unmatchTransaction,
  type StagedTransaction,
} from '../../src/importing/index.js';
import { getBudgetMonth } from '../../src/budget/index.js';

/**
 * The shared pipeline + three-tier matcher (E4.S1/S3, ADR-006), tested at the
 * domain seam — staged rows in, ledger rows out, all writes through the
 * ledger command interface. Includes the two property tests the matcher must
 * never lose: same import twice = zero new rows, and manual-entry-then-import
 * = merged, not duplicated.
 */

const OFX = readFileSync(join(import.meta.dirname, 'fixtures/rbc-chequing.ofx'), 'utf8');
const CSV = readFileSync(join(import.meta.dirname, 'fixtures/rbc-chequing.csv'), 'utf8');

let db: Database.Database;
let accountId: string;
let groceriesId: string;

function rowCount(): number {
  return getRegister(db, accountId, { limit: 500 }).totalCount;
}

function staged(over: Partial<StagedTransaction> = {}): StagedTransaction {
  return {
    date: '2026-06-05',
    payee: 'LOBLAWS 1034',
    amountMilliunits: milliunits(-43100),
    externalId: null,
    memo: '',
    accountHint: null,
    raw: null,
    ...over,
  };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  seedSystemCategories(db);
  accountId = createAccount(db, {
    name: 'Chequing',
    type: 'chequing',
    startingBalanceMilliunits: milliunits(500000),
    startingDate: '2026-01-01',
  }).id;
  groceriesId = randomUUID();
  db.prepare("INSERT INTO category_groups (id, name) VALUES ('g1', 'Everyday')").run();
  db.prepare("INSERT INTO categories (id, group_id, name) VALUES (?, 'g1', 'Groceries')").run(
    groceriesId,
  );
});
afterEach(() => db.close());

describe('T3 staging (E4.S1)', () => {
  it('AC-1/AC-4: imported rows arrive cleared + unapproved with the external id stored', () => {
    const summary = runImport(db, {
      accountId,
      source: 'file',
      staged: [staged({ externalId: 'F100' })],
    });
    expect(summary.createdIds).toHaveLength(1);
    const row = getTransaction(db, summary.createdIds[0]!);
    expect(row).toMatchObject({
      status: 'cleared',
      approved: false,
      source: 'file',
      amountMilliunits: -43100,
      date: '2026-06-05',
      payeeName: 'LOBLAWS 1034',
    });
    expect(
      db.prepare('SELECT import_id, import_batch_id FROM transactions WHERE id = ?').get(row.id),
    ).toEqual({ import_id: 'F100', import_batch_id: summary.batchId });
  });

  it('AC-4: the payee is canonicalized and its last-used category pre-suggested (FR-19)', () => {
    // teach the suggestion through a manual entry, then import the same payee
    createTransaction(db, {
      accountId,
      date: '2026-05-01',
      amountMilliunits: milliunits(-20000),
      payeeName: 'Loblaws 1034', // different casing — must resolve to the same payee
      categoryId: groceriesId,
    });
    const summary = runImport(db, { accountId, source: 'file', staged: [staged()] });
    const row = getTransaction(db, summary.createdIds[0]!);
    expect(row.payeeName).toBe('Loblaws 1034'); // first spelling wins (canonical)
    expect(row.categoryId).toBe(groceriesId);
    expect(db.prepare('SELECT COUNT(*) AS n FROM payees').get()).toEqual({ n: 2 }); // + Starting Balance
  });

  it('AC-3: the run is recorded as an ImportBatch with provenance and per-row errors', () => {
    const { errors, ...parsed } = parseOfx(OFX);
    const summary = runImport(db, {
      accountId,
      source: 'file',
      filename: 'rbc-chequing.ofx',
      format: 'ofx',
      staged: parsed.staged,
      parseErrors: errors,
    });
    const batch = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(summary.batchId) as {
      account_id: string;
      source: string;
      filename: string;
      format: string;
      created_count: number;
      skipped_count: number;
      error_count: number;
      errors: string;
    };
    expect(batch).toMatchObject({
      account_id: accountId,
      source: 'file',
      filename: 'rbc-chequing.ofx',
      format: 'ofx',
      created_count: 8, // 9 staged minus the duplicate-FITID row
      skipped_count: 1,
      error_count: 2,
    });
    expect(JSON.parse(batch.errors)).toHaveLength(2);
  });

  it('AC-5: budget effects of a manual vs an imported transaction are identical (FR-25)', () => {
    const manualDb = db;
    const importDb = openDatabase(':memory:');
    runMigrations(importDb);
    seedSystemCategories(importDb);
    const importAccount = createAccount(importDb, {
      name: 'Chequing',
      type: 'chequing',
      startingBalanceMilliunits: milliunits(500000),
      startingDate: '2026-01-01',
    }).id;
    importDb.prepare("INSERT INTO category_groups (id, name) VALUES ('g1', 'Everyday')").run();
    importDb
      .prepare("INSERT INTO categories (id, group_id, name) VALUES (?, 'g1', 'Groceries')")
      .run(groceriesId);
    // teach the payee suggestion so the imported row lands categorized
    for (const d of [manualDb, importDb]) {
      const acct = d === manualDb ? accountId : importAccount;
      createTransaction(d, {
        accountId: acct,
        date: '2026-05-01',
        amountMilliunits: milliunits(-1000),
        payeeName: 'LOBLAWS 1034',
        categoryId: groceriesId,
      });
    }
    createTransaction(manualDb, {
      accountId,
      date: '2026-06-05',
      amountMilliunits: milliunits(-43100),
      payeeName: 'LOBLAWS 1034',
      categoryId: groceriesId,
    });
    runImport(importDb, { accountId: importAccount, source: 'file', staged: [staged()] });

    const manualMonth = getBudgetMonth(manualDb, '2026-06', '2026-06-12');
    const importMonth = getBudgetMonth(importDb, '2026-06', '2026-06-12');
    expect(importMonth.rtaMilliunits).toBe(manualMonth.rtaMilliunits);
    expect(importMonth.groups).toEqual(manualMonth.groups);
    importDb.close();
  });
});

describe('T1/T1b idempotency (E4.S3 AC-1)', () => {
  it('property: importing the same OFX file twice creates zero new rows the second time', () => {
    const parsed = parseOfx(OFX);
    runImport(db, { accountId, source: 'file', staged: parsed.staged });
    const after = rowCount();
    const again = runImport(db, { accountId, source: 'file', staged: parsed.staged });
    expect(again.createdIds).toHaveLength(0);
    expect(again.mergedIds).toHaveLength(0);
    expect(again.duplicateCount).toBe(parsed.staged.length); // every row a T1 skip
    expect(rowCount()).toBe(after);
  });

  it('property: importing the same CSV (no external ids) twice creates zero new rows and changes nothing', () => {
    const parsed = parseRbcCsv(CSV);
    runImport(db, { accountId, source: 'file', staged: parsed.staged });
    const snapshot = db
      .prepare('SELECT id, status, approved, import_id FROM transactions ORDER BY rowid')
      .all();
    const again = runImport(db, { accountId, source: 'file', staged: parsed.staged });
    expect(again.createdIds).toHaveLength(0);
    expect(again.mergedIds).toHaveLength(0); // re-import is a skip, not a re-merge
    expect(
      db.prepare('SELECT id, status, approved, import_id FROM transactions ORDER BY rowid').all(),
    ).toEqual(snapshot);
  });

  it('property: randomized staged batches are idempotent (same import twice = zero new rows)', () => {
    // deterministic LCG so a failure reproduces
    let seed = 42;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let round = 0; round < 5; round += 1) {
      const batch: StagedTransaction[] = [];
      const n = (next() % 12) + 1;
      for (let i = 0; i < n; i += 1) {
        const day = (next() % 28) + 1;
        const cents = (next() % 50000) - 25000;
        const withId = next() % 2 === 0;
        batch.push(
          staged({
            date: `2026-05-${String(day).padStart(2, '0')}`,
            amountMilliunits: milliunits(cents * 10) as Milliunits,
            payee: `PAYEE ${String(next() % 7)}`,
            externalId: withId ? `R${String(round)}-${String(i)}` : null,
          }),
        );
      }
      runImport(db, { accountId, source: 'file', staged: batch });
      const before = rowCount();
      const rerun = runImport(db, { accountId, source: 'file', staged: batch });
      expect(rerun.createdIds, `round ${String(round)}`).toHaveLength(0);
      expect(rowCount(), `round ${String(round)}`).toBe(before);
    }
  });

  it('a duplicate FITID inside one file imports only once', () => {
    const parsed = parseOfx(OFX); // contains C1A0002 twice
    const summary = runImport(db, { accountId, source: 'file', staged: parsed.staged });
    expect(summary.createdIds).toHaveLength(8);
    expect(summary.duplicateCount).toBe(1);
    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM transactions WHERE import_id = ?')
        .get('C1A0002'),
    ).toEqual({ n: 1 });
  });

  it('two identical id-less rows in ONE file are two real transactions, not a self-merge', () => {
    const twoCoffees = [staged({ date: '2026-06-03' }), staged({ date: '2026-06-04' })];
    const summary = runImport(db, { accountId, source: 'file', staged: twoCoffees });
    expect(summary.createdIds).toHaveLength(2);
    expect(summary.mergedIds).toHaveLength(0);
  });
});

describe('T2 heuristic merge (E4.S3)', () => {
  function manualEntry(date = '2026-06-03'): string {
    return createTransaction(db, {
      accountId,
      date,
      amountMilliunits: milliunits(-43100),
      payeeName: 'Groceries run',
      categoryId: groceriesId,
      memo: 'my own note',
    }).id;
  }

  it('property/AC-2: a manual entry then its bank copy = ONE merged row keeping category/memo, gaining external id + cleared', () => {
    const manualId = manualEntry();
    const before = rowCount();
    const summary = runImport(db, {
      accountId,
      source: 'file',
      staged: [staged({ externalId: 'F200' })], // -43.10, two days later
    });
    expect(summary.mergedIds).toEqual([manualId]);
    expect(summary.createdIds).toHaveLength(0);
    expect(rowCount()).toBe(before); // merged, not duplicated
    const merged = getTransaction(db, manualId);
    expect(merged).toMatchObject({
      categoryId: groceriesId, // user's category preserved
      memo: 'my own note', // user's memo preserved
      payeeName: 'Groceries run', // user's payee preserved
      date: '2026-06-03', // user's date preserved
      status: 'cleared', // bank-confirmed now
      approved: false, // resurfaces in review (AC-5)
      source: 'manual',
    });
    expect(db.prepare('SELECT import_id FROM transactions WHERE id = ?').get(manualId)).toEqual({
      import_id: 'F200',
    });
  });

  it('the ±5-day window is inclusive at 5 and exclusive at 6 days', () => {
    const inWindow = manualEntry('2026-05-31'); // 5 days before the staged 06-05
    runImport(db, { accountId, source: 'file', staged: [staged({ externalId: 'F201' })] });
    expect(getTransaction(db, inWindow).approved).toBe(false); // merged

    const outOfWindow = createTransaction(db, {
      accountId,
      date: '2026-06-14', // 6 days after 06-08
      amountMilliunits: milliunits(-77700),
      payeeName: 'Too far away',
    }).id;
    const summary = runImport(db, {
      accountId,
      source: 'file',
      staged: [staged({ date: '2026-06-08', amountMilliunits: milliunits(-77700), externalId: 'F202' })],
    });
    expect(summary.mergedIds).toHaveLength(0);
    expect(summary.createdIds).toHaveLength(1);
    expect(getTransaction(db, outOfWindow).approved).toBe(true); // untouched
  });

  it('AC-4: a row already matched to one bank transaction is never merged with a second', () => {
    manualEntry();
    const summary = runImport(db, {
      accountId,
      source: 'file',
      staged: [
        staged({ date: '2026-06-04', externalId: 'F210' }),
        staged({ date: '2026-06-05', externalId: 'F211' }), // same amount, second copy
      ],
    });
    expect(summary.mergedIds).toHaveLength(1); // first one merges…
    expect(summary.createdIds).toHaveLength(1); // …second becomes its own new row
  });

  it('rows with an existing import identity are not T2 candidates', () => {
    runImport(db, { accountId, source: 'file', staged: [staged({ externalId: 'F220' })] });
    const summary = runImport(db, {
      accountId,
      source: 'file',
      staged: [staged({ date: '2026-06-06', externalId: 'F221' })], // same amount, near date
    });
    expect(summary.mergedIds).toHaveLength(0); // already-imported row is off limits
    expect(summary.createdIds).toHaveLength(1);
  });

  it('starting-balance rows are never match targets', () => {
    const summary = runImport(db, {
      accountId,
      source: 'file',
      staged: [staged({ date: '2026-01-02', amountMilliunits: milliunits(500000), externalId: 'F230' })],
    });
    expect(summary.mergedIds).toHaveLength(0);
    expect(summary.createdIds).toHaveLength(1);
  });

  it('AC-6: matching is backend-agnostic — the same staged row via "plaid" behaves identically', () => {
    const manualId = manualEntry();
    const summary = runImport(db, {
      accountId,
      source: 'plaid',
      staged: [staged({ externalId: 'plaid-txn-1' })],
    });
    expect(summary.mergedIds).toEqual([manualId]);
    expect(db.prepare('SELECT import_id FROM transactions WHERE id = ?').get(manualId)).toEqual({
      import_id: 'plaid-txn-1',
    });
  });

  it('a re-import after a merge is a no-op, even though the merged row sits on the manual date', () => {
    manualEntry('2026-06-03');
    const csvRow = staged({ date: '2026-06-05' }); // no external id — CSV-style
    runImport(db, { accountId, source: 'file', staged: [csvRow] });
    const before = rowCount();
    const again = runImport(db, { accountId, source: 'file', staged: [csvRow] });
    expect(again.createdIds).toHaveLength(0);
    expect(again.mergedIds).toHaveLength(0);
    expect(again.duplicateCount).toBe(1);
    expect(rowCount()).toBe(before);
  });

  it('AC-3: unmatch undoes the merge — the manual row reverts, the import reappears unapproved', () => {
    const manualId = manualEntry();
    runImport(db, { accountId, source: 'file', staged: [staged({ externalId: 'F240' })] });
    const before = rowCount();

    const { revertedTransaction, restoredTransaction } = unmatchTransaction(db, manualId);
    expect(rowCount()).toBe(before + 1); // two separate rows again
    expect(revertedTransaction).toMatchObject({
      id: manualId,
      status: 'uncleared', // pre-merge status restored
      approved: true, // pre-merge approval restored
      categoryId: groceriesId,
      memo: 'my own note',
    });
    expect(db.prepare('SELECT import_id FROM transactions WHERE id = ?').get(manualId)).toEqual({
      import_id: null,
    });
    expect(restoredTransaction).toMatchObject({
      date: '2026-06-05', // the IMPORTED side's own date
      amountMilliunits: -43100,
      payeeName: 'LOBLAWS 1034',
      status: 'cleared',
      approved: false,
      source: 'file',
    });
    expect(
      db.prepare('SELECT import_id FROM transactions WHERE id = ?').get(restoredTransaction.id),
    ).toEqual({ import_id: 'F240' });
    // and the match trail is gone — the manual row is mergeable again
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_candidates').get()).toEqual({ n: 0 });
  });
});

describe('reject memory (E4.S2 AC-4)', () => {
  it('a rejected external id does not reappear on the next overlapping import', () => {
    const summary = runImport(db, {
      accountId,
      source: 'file',
      staged: [staged({ externalId: 'F300' })],
    });
    const result = rejectTransaction(db, summary.createdIds[0]!);
    expect(result.rememberedExternalId).toBe('F300');
    const before = rowCount();
    const again = runImport(db, {
      accountId,
      source: 'file',
      staged: [staged({ externalId: 'F300' })],
    });
    expect(again.createdIds).toHaveLength(0);
    expect(again.rejectedCount).toBe(1);
    expect(rowCount()).toBe(before);
  });

  it('rejecting a MERGED row keeps the manual transaction and rejects only the imported copy', () => {
    const manualId = createTransaction(db, {
      accountId,
      date: '2026-06-03',
      amountMilliunits: milliunits(-43100),
      payeeName: 'Groceries run',
      categoryId: groceriesId,
      memo: 'my own note',
    }).id;
    runImport(db, { accountId, source: 'file', staged: [staged({ externalId: 'F310' })] });

    const result = rejectTransaction(db, manualId);
    expect(result.rememberedExternalId).toBe('F310');
    const manual = getTransaction(db, manualId); // still here, fully reverted
    expect(manual).toMatchObject({ approved: true, status: 'uncleared', memo: 'my own note' });
    // and the bank copy never comes back
    const again = runImport(db, { accountId, source: 'file', staged: [staged({ externalId: 'F310' })] });
    expect(again.createdIds).toHaveLength(0);
    expect(again.mergedIds).toHaveLength(0);
    expect(again.rejectedCount).toBe(1);
  });
});

describe('T1 apply-as-update (E5.S2 AC-2 — the branch the E4 notes left for Plaid `modified`)', () => {
  function importOne(over: Partial<StagedTransaction> = {}, applyUpdates = false) {
    return runImport(db, {
      accountId,
      source: 'plaid',
      staged: [staged({ externalId: 'P-1', ...over })],
      applyUpdates,
    });
  }

  it('without applyUpdates (the E4 file behavior), a changed redelivery stays a skip', () => {
    importOne();
    const again = importOne({ amountMilliunits: milliunits(-50000) }, false);
    expect(again.updatedIds).toHaveLength(0);
    expect(again.duplicateCount).toBe(1);
  });

  it('with applyUpdates, bank-owned fields update in place; the user\'s category/memo survive; row drops to unapproved', () => {
    const first = importOne();
    const rowId = first.createdIds[0]!;
    db.prepare('UPDATE transactions SET category_id = ?, memo = ?, approved = 1 WHERE id = ?').run(
      groceriesId,
      'my note',
      rowId,
    );

    const update = importOne(
      { date: '2026-06-07', amountMilliunits: milliunits(-50000) },
      true,
    );
    expect(update.updatedIds).toEqual([rowId]);
    expect(update.createdIds).toHaveLength(0);
    expect(rowCount()).toBe(2); // starting balance + the one row — never duplicated

    const row = getTransaction(db, rowId);
    expect(row).toMatchObject({
      date: '2026-06-07',
      amountMilliunits: -50000,
      categoryId: groceriesId, // user's category kept
      memo: 'my note', // user's memo kept
      approved: false, // resurfaces in review (FR-22)
    });
  });

  it('with applyUpdates, a content-identical redelivery is still an idempotent skip', () => {
    importOne();
    const again = importOne({}, true);
    expect(again.updatedIds).toHaveLength(0);
    expect(again.duplicateCount).toBe(1);
  });
});
