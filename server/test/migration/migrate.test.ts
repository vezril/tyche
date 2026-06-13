import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedSystemCategories } from '../../src/db/seed.js';
import { MigrationError, runMigration } from '../../src/migration/index.js';
import { runConsistencyCheck } from '../../src/budget/index.js';
import { listAccounts } from '../../src/ledger/index.js';

/**
 * E6.S1 + E6.S2 against a realistic YNAB export pair (fixtures modeled on
 * docs/analysis/ynab-usage.md): 5 accounts incl. a tracking TFSA, 10 groups /
 * 30 categories (one hidden), 4 budget months, splits (both complete and
 * ambiguous), transfers (on↔on, on↔tracking, unpaired), an overspent category,
 * locale-formatted amounts, a malformed row, a flagged row and an
 * uncategorized row. FR-30's Verified-by — balances and current-month
 * availables match the source to the cent — is asserted via the parity report
 * AND independently against hand-computed sums.
 */

const FIXTURES = join(import.meta.dirname, 'fixtures');
const REGISTER = readFileSync(join(FIXTURES, 'register.csv'), 'utf8');
const PLAN = readFileSync(join(FIXTURES, 'plan.csv'), 'utf8');

interface Rig {
  db: Database.Database;
  dir: string;
}

function createDb(): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'tyche-e6-'));
  const db = openDatabase(join(dir, 'app.db'));
  runMigrations(db);
  seedSystemCategories(db);
  return { db, dir };
}

function destroyDb(rig: Rig): void {
  rig.db.close();
  rmSync(rig.dir, { recursive: true, force: true });
}

function migrate(db: Database.Database) {
  return runMigration(db, {
    registerCsv: REGISTER,
    planCsv: PLAN,
    registerFilename: 'register.csv',
    planFilename: 'plan.csv',
  });
}

describe('runMigration on the YNAB fixture pair', () => {
  let rig: Rig;
  let result: ReturnType<typeof migrate>;

  beforeEach(() => {
    rig = createDb();
    result = migrate(rig.db);
  });
  afterEach(() => destroyDb(rig));

  // --- S1 AC-1: structure --------------------------------------------------

  it('creates all five accounts with inferred types and starting balances', () => {
    const accounts = listAccounts(rig.db, { includeClosed: true });
    expect(accounts).toHaveLength(5);
    expect(result.accountCount).toBe(5);

    const byName = new Map(accounts.map((a) => [a.name, a]));
    const tfsa = byName.get('TFSA – 1676')!;
    expect(tfsa.type).toBe('tracking');
    expect(tfsa.onBudget).toBe(false);
    for (const name of [
      'Primary Chequing – Automatic Payments',
      'Spending Account',
      'Savings',
      'RBC Signature No Limit Banking – 2501',
    ]) {
      expect(byName.get(name)!.onBudget, name).toBe(true);
    }

    // The YNAB "Starting Balance" register row became THE starting-balance
    // transaction (one row, reconciled status preserved), not a duplicate.
    const sb = rig.db
      .prepare(
        `SELECT t.amount_milliunits AS amount, t.date, t.status
         FROM transactions t JOIN accounts a ON a.id = t.account_id
         WHERE a.name = ? AND t.is_starting_balance = 1`,
      )
      .all('TFSA – 1676') as { amount: number; date: string; status: string }[];
    expect(sb).toEqual([{ amount: 12_345_670, date: '2026-03-01', status: 'reconciled' }]);
  });

  it('creates category groups and categories with order and hidden flags', () => {
    expect(result.categoryGroupCount).toBe(10);
    expect(result.categoryCount).toBe(30);

    const groups = rig.db
      .prepare(
        'SELECT name, hidden FROM category_groups WHERE is_system = 0 ORDER BY sort_order',
      )
      .all() as { name: string; hidden: number }[];
    expect(groups.map((g) => g.name)).toEqual([
      'Savings Goals', 'Debt Payments', 'Fixed Bills', 'Variable Spending', 'Fun Money',
      'Workshop', 'Health', 'Giving', 'Quality of Life', 'Hidden Categories',
    ]);
    expect(groups.find((g) => g.name === 'Hidden Categories')!.hidden).toBe(1);

    const variable = rig.db
      .prepare(
        `SELECT c.name, c.hidden FROM categories c JOIN category_groups g ON g.id = c.group_id
         WHERE g.name = 'Variable Spending' ORDER BY c.sort_order`,
      )
      .all() as { name: string; hidden: number }[];
    expect(variable.map((c) => c.name)).toEqual([
      'Groceries', 'Eating Out', 'Alcohol', 'Gas', 'Home & Everyday',
    ]);
    const oldHobby = rig.db
      .prepare('SELECT hidden FROM categories WHERE name = ?')
      .get('Old Hobby') as { hidden: number };
    expect(oldHobby.hidden).toBe(1);
  });

  it('creates the payee list (transfer pseudo-payees excluded)', () => {
    expect(result.payeeCount).toBe(38);
    const transferPayees = rig.db
      .prepare("SELECT name FROM payees WHERE name LIKE 'Transfer :%'")
      .all() as { name: string }[];
    // Only the UNPAIRED transfer keeps its payee text; real pairs have none.
    expect(transferPayees.map((p) => p.name)).toEqual(['Transfer : Old Mastercard']);
  });

  // --- S1 AC-2/AC-4: rows land losslessly, approved, source=migration -------

  it('imports every mappable register row: milliunit amounts, memo, cleared status', () => {
    const row = rig.db
      .prepare(
        `SELECT t.amount_milliunits AS amount, t.memo, t.status, t.approved, t.source
         FROM transactions t JOIN payees p ON p.id = t.payee_id
         WHERE p.name = 'M&M Food Market'`,
      )
      .get() as { amount: number; memo: string; status: string; approved: number; source: string };
    expect(row).toEqual({
      amount: -198_930,
      memo: 'BBQ party run',
      status: 'cleared',
      approved: 1,
      source: 'migration',
    });

    // Quoted memo with comma + escaped quotes survives the CSV round-trip.
    const quoted = rig.db
      .prepare("SELECT memo FROM transactions WHERE memo LIKE 'weekly%'")
      .get() as { memo: string };
    expect(quoted.memo).toBe('weekly, "big" run');

    // Uncleared and reconciled statuses preserved (FR-17/18).
    const uncleared = rig.db
      .prepare(
        "SELECT status FROM transactions WHERE date = '2026-06-10' AND amount_milliunits = -88200",
      )
      .get() as { status: string };
    expect(uncleared.status).toBe('uncleared');

    expect(result.transactionCount).toBe(104);
    const unapproved = rig.db
      .prepare('SELECT COUNT(*) AS n FROM transactions WHERE approved = 0')
      .get() as { n: number };
    expect(unapproved.n).toBe(0); // migrated rows skip the review queue (AC-4)
    const sources = rig.db
      .prepare(
        "SELECT DISTINCT source FROM transactions WHERE is_starting_balance = 0 ORDER BY source",
      )
      .all() as { source: string }[];
    expect(sources.map((s) => s.source)).toEqual(['migration']);
  });

  // --- S1 AC-3: splits + transfers reconstructed ----------------------------

  it('reconstructs "(Split n/m)" groups as parent + lines summing exactly', () => {
    expect(result.splitCount).toBe(2);
    const costco = rig.db
      .prepare(
        `SELECT t.id, t.amount_milliunits AS amount, t.category_id
         FROM transactions t JOIN payees p ON p.id = t.payee_id
         WHERE p.name = 'Costco' AND t.parent_id IS NULL`,
      )
      .get() as { id: string; amount: number; category_id: string | null };
    expect(costco.amount).toBe(-127_750);
    expect(costco.category_id).toBeNull();
    const lines = rig.db
      .prepare(
        `SELECT l.amount_milliunits AS amount, c.name AS category, l.memo
         FROM transactions l JOIN categories c ON c.id = l.category_id
         WHERE l.parent_id = ? ORDER BY l.rowid`,
      )
      .all(costco.id) as { amount: number; category: string; memo: string }[];
    expect(lines).toEqual([
      { amount: -85_500, category: 'Groceries', memo: 'groceries' },
      { amount: -42_250, category: 'Home & Everyday', memo: 'household' },
    ]);

    // The 3-line split with a positive (return) line also reconstructs.
    const tire = rig.db
      .prepare(
        `SELECT t.id, t.amount_milliunits AS amount FROM transactions t
         JOIN payees p ON p.id = t.payee_id
         WHERE p.name = 'Canadian Tire' AND t.parent_id IS NULL`,
      )
      .get() as { id: string; amount: number };
    expect(tire.amount).toBe(-85_000);
    const tireLines = rig.db
      .prepare('SELECT COUNT(*) AS n FROM transactions WHERE parent_id = ?')
      .get(tire.id) as { n: number };
    expect(tireLines.n).toBe(3);

    // Ambiguous group (only 1/2 present): imported as a separate row + reported.
    const amazon = rig.db
      .prepare(
        `SELECT t.parent_id, t.memo FROM transactions t JOIN payees p ON p.id = t.payee_id
         WHERE p.name = 'Amazon'`,
      )
      .all() as { parent_id: string | null; memo: string }[];
    expect(amazon).toHaveLength(1);
    expect(amazon[0]!.parent_id).toBeNull();
    expect(result.discrepancies.some((d) => /split/i.test(d.reason))).toBe(true);
  });

  it('reconstructs transfers as linked pairs, never two orphans', () => {
    expect(result.transferCount).toBe(8);
    const orphans = rig.db
      .prepare(
        `SELECT t.transfer_id, COUNT(*) AS n FROM transactions t
         WHERE t.transfer_id IS NOT NULL GROUP BY t.transfer_id HAVING n <> 2`,
      )
      .all();
    expect(orphans).toEqual([]);
    const pairs = rig.db
      .prepare('SELECT COUNT(DISTINCT transfer_id) AS n FROM transactions WHERE transfer_id IS NOT NULL')
      .get() as { n: number };
    expect(pairs.n).toBe(8);

    // Mixed on-budget↔tracking transfer: category (FHSA) on the on-budget side
    // only; per-side cleared status preserved (May: chequing cleared).
    const mixed = rig.db
      .prepare(
        `SELECT a.name AS account, t.amount_milliunits AS amount, t.status, c.name AS category
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.transfer_id IS NOT NULL AND t.date = '2026-03-20'
         ORDER BY a.name`,
      )
      .all() as { account: string; amount: number; status: string; category: string | null }[];
    expect(mixed).toEqual([
      {
        account: 'Primary Chequing – Automatic Payments',
        amount: -200_000,
        status: 'reconciled',
        category: 'FHSA',
      },
      { account: 'TFSA – 1676', amount: 200_000, status: 'cleared', category: null },
    ]);

    // on↔on transfers carry no category on either side.
    const onOn = rig.db
      .prepare(
        `SELECT COUNT(*) AS n FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE t.transfer_id IS NOT NULL AND t.category_id IS NOT NULL AND a.on_budget = 1
           AND t.date <> '2026-03-20' AND t.date <> '2026-04-20' AND t.date <> '2026-05-20'`,
      )
      .get() as { n: number };
    expect(onOn.n).toBe(0);
  });

  // --- S1 AC-5 + S2 AC-2: to-the-cent parity ---------------------------------

  it('matches every account balance to the cent (hand-computed and via the report)', () => {
    const accounts = new Map(
      listAccounts(rig.db, { includeClosed: true }).map((a) => [a.name, a.workingBalanceMilliunits]),
    );
    expect(accounts.get('Primary Chequing – Automatic Payments')).toBe(5_151_960);
    expect(accounts.get('Spending Account')).toBe(1_079_980);
    expect(accounts.get('Savings')).toBe(12_000_000);
    expect(accounts.get('RBC Signature No Limit Banking – 2501')).toBe(191_400);
    expect(accounts.get('TFSA – 1676')).toBe(13_095_670);

    expect(result.parity.accounts).toHaveLength(5);
    expect(result.parity.accounts.every((a) => a.ok)).toBe(true);
    const tfsa = result.parity.accounts.find((a) => a.accountName === 'TFSA – 1676')!;
    expect(tfsa.sourceBalanceMilliunits).toBe(13_095_670);
    expect(tfsa.importedBalanceMilliunits).toBe(13_095_670);
  });

  it('matches every current-month category available to the Plan CSV (S2 AC-2)', () => {
    expect(result.parity.month).toBe('2026-06');
    expect(result.parity.categories).toHaveLength(30);
    const failures = result.parity.categories.filter((c) => !c.ok);
    expect(failures).toEqual([]);

    const groceries = result.parity.categories.find((c) => c.categoryName === 'Groceries')!;
    expect(groceries.sourceAvailableMilliunits).toBe(416_400);
    expect(groceries.computedAvailableMilliunits).toBe(416_400);
    expect(result.parity.ok).toBe(true);
  });

  // --- S2 AC-1: per-month assignments ----------------------------------------

  it('imports every nonzero (category, month) assigned amount losslessly', () => {
    expect(result.assignmentCount).toBe(115);
    const n = rig.db.prepare('SELECT COUNT(*) AS n FROM month_assignments').get() as {
      n: number;
    };
    expect(n.n).toBe(115);
    const may = rig.db
      .prepare(
        `SELECT m.assigned_milliunits AS amount FROM month_assignments m
         JOIN categories c ON c.id = m.category_id
         WHERE c.name = 'Groceries' AND m.month = '2026-05'`,
      )
      .get() as { amount: number };
    expect(may.amount).toBe(500_000);
  });

  // --- S1 AC-6 + S2 AC-5: the discrepancy report ------------------------------

  it('reports every unmappable or caveated construct, never silently dropping', () => {
    const reasons = result.discrepancies.map((d) => `${d.source}:${d.line}:${d.reason}`);
    const expectContaining = (pattern: RegExp): void => {
      expect(reasons.some((r) => pattern.test(r)), String(pattern)).toBe(true);
    };
    expectContaining(/register:122:.*amount/); // malformed Outflow "C$12.x4"
    expectContaining(/Old Mastercard/); // unpaired transfer
    expectContaining(/split/i); // ambiguous "(Split 1/2)" group
    expectContaining(/flag/i); // flag "Red" has no equivalent
    expectContaining(/uncategorized/i); // Interac e-Transfer row
    expectContaining(/tracking/); // TFSA type inference is called out
  });

  // --- S2 AC-6: the NFR-12 consistency check ----------------------------------

  it('passes the NFR-12 consistency check on the migrated dataset', () => {
    expect(result.consistency.ok).toBe(true);
    expect(result.consistency.mismatches).toEqual([]);
    const independent = runConsistencyCheck(rig.db, '2026-06');
    expect(independent.ok).toBe(true);
  });
});

// --- S2 AC-3: deterministic re-run from scratch --------------------------------

/** Everything content-bearing, with generated ids/timestamps normalized away. */
function canonicalState(db: Database.Database): unknown {
  const accounts = db
    .prepare('SELECT name, type, on_budget, closed FROM accounts ORDER BY name')
    .all();
  const groups = db
    .prepare('SELECT name, sort_order, hidden, is_system FROM category_groups ORDER BY sort_order, name')
    .all();
  const categories = db
    .prepare(
      `SELECT g.name AS grp, c.name, c.sort_order, c.hidden, c.is_system
       FROM categories c JOIN category_groups g ON g.id = c.group_id
       ORDER BY g.sort_order, c.sort_order, c.name`,
    )
    .all();
  const payees = db.prepare('SELECT name FROM payees ORDER BY name').all();
  const transactions = db
    .prepare(
      `SELECT a.name AS account, t.date, t.amount_milliunits AS amount,
              p.name AS payee, c.name AS category, t.memo, t.status, t.approved,
              t.source, t.is_starting_balance AS sb,
              t.parent_id IS NOT NULL AS is_line,
              t.transfer_id IS NOT NULL AS is_transfer,
              pa.name AS peer_account
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN payees p ON p.id = t.payee_id
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN transactions peer
         ON t.transfer_id IS NOT NULL AND peer.transfer_id = t.transfer_id AND peer.id <> t.id
       LEFT JOIN accounts pa ON pa.id = peer.account_id
       ORDER BY t.rowid`,
    )
    .all();
  const assignments = db
    .prepare(
      `SELECT c.name AS category, m.month, m.assigned_milliunits AS amount
       FROM month_assignments m JOIN categories c ON c.id = m.category_id
       ORDER BY m.month, c.name`,
    )
    .all();
  return { accounts, groups, categories, payees, transactions, assignments };
}

describe('idempotency / re-runnability (FR-31)', () => {
  it('two runs from scratch produce row-for-row equivalent data (S2 AC-3)', () => {
    const a = createDb();
    const b = createDb();
    try {
      const resultA = migrate(a.db);
      const resultB = migrate(b.db);
      expect(canonicalState(b.db)).toEqual(canonicalState(a.db));
      expect(resultB).toMatchObject({
        accountCount: resultA.accountCount,
        transactionCount: resultA.transactionCount,
        assignmentCount: resultA.assignmentCount,
        discrepancies: resultA.discrepancies,
        parity: resultA.parity,
      });
    } finally {
      destroyDb(a);
      destroyDb(b);
    }
  });

  it('refuses to run into a non-empty budget without touching it (S2 AC-4)', () => {
    const rig = createDb();
    try {
      migrate(rig.db);
      const before = canonicalState(rig.db);
      expect(() => migrate(rig.db)).toThrowError(MigrationError);
      try {
        migrate(rig.db);
      } catch (err) {
        expect((err as MigrationError).code).toBe('budget_not_empty');
      }
      expect(canonicalState(rig.db)).toEqual(before); // nothing half-applied
    } finally {
      destroyDb(rig);
    }
  });

  it('refuses when only structure exists (any non-seed data counts)', () => {
    const rig = createDb();
    try {
      rig.db
        .prepare(
          "INSERT INTO category_groups (id, name, sort_order, hidden, is_system) VALUES ('g1', 'Stuff', 1, 0, 0)",
        )
        .run();
      expect(() => migrate(rig.db)).toThrowError(MigrationError);
    } finally {
      destroyDb(rig);
    }
  });
});
