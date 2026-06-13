import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { milliunits } from '@ynab-clone/shared';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedSystemCategories, INFLOW_READY_TO_ASSIGN_CATEGORY_ID } from '../../src/db/seed.js';
import { createAccount, createTransaction } from '../../src/ledger/index.js';
import { setAssignedAmount } from '../../src/budget/index.js';
import { diffBudgets, runConsistencyCheck } from '../../src/budget/consistency.js';
import { computeBudget, categoryMonthKey, type EngineInput } from '../../src/budget/engine.js';

// AC-6 / NFR-12: the consistency check recomputes the budget from raw rows via
// an INDEPENDENT in-memory walk (no SQL aggregation) and compares it against
// the SQL-aggregation path the API serves. E7.S4 exposes this user-facing;
// here it must exist, work, and actually detect differences.

describe('budget consistency check (AC-6, NFR-12)', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ynab-e3-consistency-'));
    db = openDatabase(join(dir, 'app.db'));
    runMigrations(db);
    seedSystemCategories(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seedRealisticData(): void {
    db.prepare("INSERT INTO category_groups (id, name, sort_order) VALUES ('g1', 'Everyday', 1)").run();
    db.prepare("INSERT INTO categories (id, group_id, name) VALUES ('groceries', 'g1', 'Groceries')").run();
    db.prepare("INSERT INTO categories (id, group_id, name) VALUES ('dining', 'g1', 'Dining')").run();

    const chequing = createAccount(db, {
      name: 'Chequing',
      type: 'chequing',
      startingBalanceMilliunits: milliunits(500_000),
      startingDate: '2026-01-01',
    });
    const savings = createAccount(db, {
      name: 'Savings',
      type: 'savings',
      startingBalanceMilliunits: milliunits(0),
      startingDate: '2026-01-01',
    });
    const tfsa = createAccount(db, {
      name: 'TFSA',
      type: 'tracking',
      startingBalanceMilliunits: milliunits(10_000_000),
      startingDate: '2026-01-01',
    });

    // Income, spending, an overspend, a split, a transfer pair, a tracking transfer.
    createTransaction(db, {
      accountId: chequing.id,
      date: '2026-01-15',
      amountMilliunits: milliunits(2_000_000),
      payeeName: 'Employer',
      categoryId: INFLOW_READY_TO_ASSIGN_CATEGORY_ID,
      memo: '',
    });
    createTransaction(db, {
      accountId: chequing.id,
      date: '2026-01-20',
      amountMilliunits: milliunits(-150_000),
      payeeName: 'Loblaws',
      categoryId: 'groceries',
      memo: '',
    });
    createTransaction(db, {
      accountId: chequing.id,
      date: '2026-02-03',
      amountMilliunits: milliunits(-90_000),
      payeeName: 'Costco',
      categoryId: null,
      memo: 'split',
      splits: [
        { categoryId: 'groceries', amountMilliunits: milliunits(-60_000), memo: '' },
        { categoryId: 'dining', amountMilliunits: milliunits(-30_000), memo: '' },
      ],
    });
    createTransaction(db, {
      accountId: chequing.id,
      date: '2026-02-10',
      amountMilliunits: milliunits(-100_000),
      payeeName: null,
      categoryId: null,
      memo: 'to savings',
      transferAccountId: savings.id,
    });
    createTransaction(db, {
      accountId: chequing.id,
      date: '2026-03-01',
      amountMilliunits: milliunits(-200_000),
      payeeName: null,
      categoryId: 'groceries',
      memo: 'to tfsa',
      transferAccountId: tfsa.id,
    });

    setAssignedAmount(db, 'groceries', '2026-01', milliunits(100_000)); // ends Jan overspent −$50
    setAssignedAmount(db, 'dining', '2026-02', milliunits(50_000));
    setAssignedAmount(db, 'groceries', '2026-04', milliunits(75_000)); // future month
  }

  it('passes on a dataset with splits, transfers, tracking accounts, and overspends', () => {
    seedRealisticData();
    const report = runConsistencyCheck(db, '2026-06');
    expect(report.mismatches).toEqual([]);
    expect(report.ok).toBe(true);
    // E7.S4: the report proves coverage — accounts and months were walked.
    expect(report.checkedAccounts).toBe(3);
    expect(report.checkedMonths).toBeGreaterThanOrEqual(6); // 2026-01..2026-06
  });

  it('passes on a completely empty database', () => {
    const report = runConsistencyCheck(db, '2026-06');
    expect(report.ok).toBe(true);
  });

  // --- E7.S4 AC-5: deliberate raw-row corruption is detected and pinpointed ---

  it('detects and PINPOINTS a tampered split line (E7.S4 AC-5)', () => {
    seedRealisticData();
    // Tamper ONE split line: category activity changes while the parent's
    // account-facing total does not — only the FR-15 invariant can see it.
    const line = db
      .prepare(
        `SELECT id, parent_id AS parentId FROM transactions
         WHERE parent_id IS NOT NULL AND category_id = 'dining'`,
      )
      .get() as { id: string; parentId: string };
    db.prepare('UPDATE transactions SET amount_milliunits = amount_milliunits - 5000 WHERE id = ?').run(line.id);

    const report = runConsistencyCheck(db, '2026-06');
    expect(report.ok).toBe(false);
    // Pinpointed: the affected parent is named, with both values (AC-3/AC-5).
    expect(report.mismatches.join('\n')).toContain(`split parent ${line.parentId}`);
    expect(report.mismatches.join('\n')).toContain('-95000 vs parent total -90000');
  });

  it('detects a tampered transfer side (one-sided money creation)', () => {
    seedRealisticData();
    const side = db
      .prepare(
        `SELECT id, transfer_id AS transferId FROM transactions
         WHERE transfer_id IS NOT NULL AND amount_milliunits = -100000`,
      )
      .get() as { id: string; transferId: string };
    db.prepare('UPDATE transactions SET amount_milliunits = -99000 WHERE id = ?').run(side.id);

    const report = runConsistencyCheck(db, '2026-06');
    expect(report.ok).toBe(false);
    expect(report.mismatches.join('\n')).toContain(`transfer ${side.transferId}`);
  });

  it('exact integer equality — a single milliunit of drift fails (E7.S4 AC-4)', () => {
    seedRealisticData();
    const line = db
      .prepare("SELECT id FROM transactions WHERE parent_id IS NOT NULL AND category_id = 'groceries'")
      .get() as { id: string };
    db.prepare('UPDATE transactions SET amount_milliunits = amount_milliunits + 1 WHERE id = ?').run(line.id);
    expect(runConsistencyCheck(db, '2026-06').ok).toBe(false);
  });

  it('a blanked UNLINKED Plaid token is NOT flagged (E5.S5 contract)', () => {
    seedRealisticData();
    db.prepare(
      `INSERT INTO plaid_items (id, plaid_item_id, access_token_ciphertext, status)
       VALUES ('item-x', 'p-x:unlinked:item-x', '', 'UNLINKED')`,
    ).run();
    expect(runConsistencyCheck(db, '2026-06').ok).toBe(true);
  });

  it('diffBudgets reports nothing for identical computations', () => {
    const engineInput: EngineInput = {
      categoryIds: ['a'],
      activity: new Map([[categoryMonthKey('a', '2026-01'), milliunits(-5_000)]]),
      assigned: new Map(),
      inflowsByMonth: new Map([['2026-01', milliunits(100_000)]]),
    };
    expect(
      diffBudgets(computeBudget(engineInput, '2026-02'), computeBudget(engineInput, '2026-02')),
    ).toEqual([]);
  });

  it('diffBudgets DETECTS a divergence (the check can actually fail)', () => {
    const engineInput: EngineInput = {
      categoryIds: ['a'],
      activity: new Map([[categoryMonthKey('a', '2026-01'), milliunits(-5_000)]]),
      assigned: new Map(),
      inflowsByMonth: new Map([['2026-01', milliunits(100_000)]]),
    };
    const tampered: EngineInput = {
      ...engineInput,
      activity: new Map([[categoryMonthKey('a', '2026-01'), milliunits(-6_000)]]),
    };
    const mismatches = diffBudgets(
      computeBudget(engineInput, '2026-02'),
      computeBudget(tampered, '2026-02'),
    );
    expect(mismatches.length).toBeGreaterThan(0);
    expect(mismatches.join('\n')).toContain('2026-01');
  });
});
