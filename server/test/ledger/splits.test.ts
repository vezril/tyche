import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { milliunits } from '@ynab-clone/shared';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedSystemCategories } from '../../src/db/seed.js';
import {
  accountBalances,
  createAccount,
  createTransaction,
  deleteTransaction,
  getRegister,
  LedgerError,
  listAccounts,
  updateTransaction,
} from '../../src/ledger/index.js';

// E2.S4 domain logic: split transactions as child rows referencing the parent
// (architecture §5). The parent carries the total; lines carry category +
// amount + memo and MUST sum to the parent (FR-15). Balances count the parent
// once (ADR-005); the budget engine's activity sum sees the LINES' categories.

describe('ledger splits (E2.S4)', () => {
  let db: Database.Database;
  let accountId: string;
  let groceriesId: string;
  let householdId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db);
    seedSystemCategories(db);
    db.prepare("INSERT INTO category_groups (id, name) VALUES ('g1', 'Everyday')").run();
    groceriesId = 'cat-groceries';
    householdId = 'cat-household';
    const insert = db.prepare("INSERT INTO categories (id, group_id, name) VALUES (?, 'g1', ?)");
    insert.run(groceriesId, 'Groceries');
    insert.run(householdId, 'Household');
    accountId = createAccount(db, {
      name: 'Spending',
      type: 'chequing',
      startingBalanceMilliunits: milliunits(500000),
      startingDate: '2026-01-01',
    }).id;
  });
  afterEach(() => {
    db.close();
  });

  const costcoSplit = () =>
    createTransaction(db, {
      accountId,
      date: '2026-06-10',
      amountMilliunits: milliunits(-130000),
      payeeName: 'Costco',
      splits: [
        { categoryId: groceriesId, amountMilliunits: milliunits(-80000), memo: 'food' },
        { categoryId: householdId, amountMilliunits: milliunits(-50000) },
      ],
    });

  it('AC-1: a valid split saves; each line posts its amount to its category (FR-15)', () => {
    const t = costcoSplit();
    expect(t.lines).toHaveLength(2);
    expect(t.lines.map((l) => l.categoryId).sort()).toEqual([groceriesId, householdId].sort());
    expect(t.categoryId).toBeNull(); // parent carries no category of its own

    // E3's activity(c, m) sums transaction LINES by category_id and date —
    // the child rows must be visible to that exact GROUP BY.
    const activity = db
      .prepare(
        `SELECT category_id, SUM(amount_milliunits) AS total
         FROM transactions WHERE category_id IN (?, ?) GROUP BY category_id`,
      )
      .all(groceriesId, householdId) as { category_id: string; total: number }[];
    expect(activity.find((r) => r.category_id === groceriesId)?.total).toBe(-80000);
    expect(activity.find((r) => r.category_id === householdId)?.total).toBe(-50000);
  });

  it('AC-2: lines that do not sum to the total are rejected, naming the discrepancy (FR-15)', () => {
    expect(() =>
      createTransaction(db, {
        accountId,
        date: '2026-06-10',
        amountMilliunits: milliunits(-130000),
        splits: [
          { categoryId: groceriesId, amountMilliunits: milliunits(-80000) },
          { categoryId: householdId, amountMilliunits: milliunits(-45000) },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'split_sum_mismatch',
        details: { discrepancyMilliunits: 5000 }, // lines fall $5 short of the total
      }) as Error,
    );
    // nothing was written
    expect(accountBalances(db, accountId).workingMilliunits).toBe(500000);
  });

  it('AC-3: the account balance counts a split ONCE; the register shows one row with lines', () => {
    costcoSplit();
    expect(accountBalances(db, accountId).workingMilliunits).toBe(500000 - 130000);
    expect(
      listAccounts(db, { includeClosed: false }).find((a) => a.id === accountId)
        ?.workingBalanceMilliunits,
    ).toBe(500000 - 130000);

    const page = getRegister(db, accountId);
    expect(page.totalCount).toBe(2); // starting balance + the one split parent
    const parent = page.transactions.find((t) => t.payeeName === 'Costco');
    expect(parent?.amountMilliunits).toBe(-130000);
    expect(parent?.lines).toHaveLength(2);
    expect(page.filteredTotalMilliunits).toBe(500000 - 130000);
  });

  it('AC-3: filtering the register by a line category finds the split parent', () => {
    costcoSplit();
    const page = getRegister(db, accountId, { categoryId: householdId });
    expect(page.totalCount).toBe(1);
    expect(page.transactions[0]?.payeeName).toBe('Costco');
  });

  it('AC-4: editing replaces the lines wholesale and re-enforces the sum', () => {
    const t = costcoSplit();
    const updated = updateTransaction(db, t.id, {
      amountMilliunits: milliunits(-140000),
      splits: [
        { categoryId: groceriesId, amountMilliunits: milliunits(-90000) },
        { categoryId: householdId, amountMilliunits: milliunits(-50000) },
      ],
    });
    expect(updated.lines.map((l) => l.amountMilliunits).sort()).toEqual([-90000, -50000].sort());
    expect(accountBalances(db, accountId).workingMilliunits).toBe(500000 - 140000);

    // changing the parent amount WITHOUT new lines breaks the sum → rejected
    expect(() =>
      updateTransaction(db, t.id, { amountMilliunits: milliunits(-150000) }),
    ).toThrowError(expect.objectContaining({ code: 'split_sum_mismatch' }) as Error);
  });

  it('AC-4: un-splitting (splits: null) removes the lines and allows a direct category', () => {
    const t = costcoSplit();
    const updated = updateTransaction(db, t.id, { splits: null, categoryId: groceriesId });
    expect(updated.lines).toHaveLength(0);
    expect(updated.categoryId).toBe(groceriesId);
    const children = db
      .prepare('SELECT COUNT(*) AS n FROM transactions WHERE parent_id = ?')
      .get(t.id) as { n: number };
    expect(children.n).toBe(0);
  });

  it('AC-4: editing the parent date moves the lines with it (activity is month-bucketed)', () => {
    const t = costcoSplit();
    updateTransaction(db, t.id, { date: '2026-07-02' });
    const dates = db
      .prepare('SELECT DISTINCT date FROM transactions WHERE parent_id = ?')
      .all(t.id) as { date: string }[];
    expect(dates).toEqual([{ date: '2026-07-02' }]);
  });

  it('AC-5: integer milliunit lines summing exactly to the whole are accepted as entered', () => {
    // An "awkward third" that no float or auto-divide could produce: entered
    // integer parts that sum exactly (ADR-004 / FR-32).
    const t = createTransaction(db, {
      accountId,
      date: '2026-06-10',
      amountMilliunits: milliunits(-10000),
      splits: [
        { categoryId: groceriesId, amountMilliunits: milliunits(-3330) },
        { categoryId: householdId, amountMilliunits: milliunits(-3330) },
        { categoryId: groceriesId, amountMilliunits: milliunits(-3340) },
      ],
    });
    expect(t.lines.reduce((sum, l) => sum + l.amountMilliunits, 0)).toBe(-10000);
  });

  it('rejects a split with fewer than two lines', () => {
    expect(() =>
      createTransaction(db, {
        accountId,
        date: '2026-06-10',
        amountMilliunits: milliunits(-100),
        splits: [{ categoryId: groceriesId, amountMilliunits: milliunits(-100) }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'split_requires_two_lines' }) as Error);
  });

  it('rejects categorized splits on tracking accounts (FR-10)', () => {
    const tracking = createAccount(db, {
      name: 'TFSA',
      type: 'tracking',
      startingBalanceMilliunits: milliunits(0),
      startingDate: '2026-01-01',
    });
    expect(() =>
      createTransaction(db, {
        accountId: tracking.id,
        date: '2026-06-10',
        amountMilliunits: milliunits(-100),
        splits: [
          { categoryId: groceriesId, amountMilliunits: milliunits(-50) },
          { categoryId: householdId, amountMilliunits: milliunits(-50) },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'split_not_allowed_on_tracking_account' }) as Error,
    );
  });

  it('rejects a direct category on a split parent', () => {
    const t = costcoSplit();
    expect(() => updateTransaction(db, t.id, { categoryId: groceriesId })).toThrowError(
      expect.objectContaining({ code: 'category_not_allowed_on_split_parent' }) as Error,
    );
  });

  it('split lines are not addressable as transactions (edit/delete go through the parent)', () => {
    const t = costcoSplit();
    const child = db
      .prepare('SELECT id FROM transactions WHERE parent_id = ? LIMIT 1')
      .get(t.id) as { id: string };
    expect(() => updateTransaction(db, child.id, { memo: 'x' })).toThrowError(LedgerError);
    expect(() => deleteTransaction(db, child.id)).toThrowError(
      expect.objectContaining({ code: 'split_line_not_addressable' }) as Error,
    );
  });

  it('deleting the parent removes the lines and restores the balance', () => {
    const t = costcoSplit();
    deleteTransaction(db, t.id);
    expect(accountBalances(db, accountId).workingMilliunits).toBe(500000);
    const orphans = db
      .prepare('SELECT COUNT(*) AS n FROM transactions WHERE parent_id = ?')
      .get(t.id) as { n: number };
    expect(orphans.n).toBe(0);
  });
});
