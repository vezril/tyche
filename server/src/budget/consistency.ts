import type Database from 'better-sqlite3';
import { milliunits, type Milliunits } from '@ynab-clone/shared';
import { INFLOW_READY_TO_ASSIGN_CATEGORY_ID } from '../db/seed.js';
import { categoryMonthKey, computeBudget, type EngineInput, type MonthValues } from './engine.js';
import { monthOfDate } from './month.js';
import { loadEngineInputs } from './queries.js';

/**
 * NFR-12 consistency check (E3.S1 AC-6; exposed to the user by E7.S4).
 *
 * Two derivations of every budget number from the same raw rows:
 *   path A — the serving path: SQL GROUP BY aggregation (queries.ts);
 *   path B — an independent in-memory walk over INDIVIDUAL transaction rows,
 *            no SQL aggregation anywhere.
 * Both feed the one audited fold (ADR-005 concentrates the recurrences there
 * on purpose — the cross-check targets the aggregation layer, where the
 * split/transfer/tracking filters live). Any difference is reported, never
 * repaired: with no stored aggregates there is nothing to repair.
 *
 * E7.S4 extends the same report with:
 *   - account working/cleared balances (AC-1): the serving SUM (the exact
 *     query shape ledger/accounts.ts serves) vs a per-row in-memory walk;
 *   - raw-row structural invariants the aggregations TRUST and therefore
 *     cannot themselves detect when violated (AC-5): split children must sum
 *     exactly to their parent's account-facing total (FR-15), and a transfer
 *     id must name exactly two rows whose amounts cancel (FR-16). A tampered
 *     split line or transfer side is pinpointed by transaction id.
 * All comparisons are exact integer equality — milliunits, no epsilon (AC-4).
 */

export interface ConsistencyReport {
  ok: boolean;
  mismatches: string[];
  /** Coverage counters (E7.S4): proof the check actually walked the data. */
  checkedAccounts: number;
  checkedMonths: number;
}

/** Path B: per-row in-memory aggregation — deliberately NO SQL SUM/GROUP BY. */
function walkRawRows(db: Database.Database): EngineInput {
  const categoryIds = (
    db.prepare('SELECT id FROM categories WHERE id <> ?').all(
      INFLOW_READY_TO_ASSIGN_CATEGORY_ID,
    ) as { id: string }[]
  ).map((r) => r.id);

  const activity = new Map<string, Milliunits>();
  const inflowsByMonth = new Map<string, Milliunits>();
  for (const row of db
    .prepare(
      `SELECT t.date, t.amount_milliunits AS amount, t.category_id AS categoryId
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       WHERE a.on_budget = 1`,
    )
    .iterate() as IterableIterator<{ date: string; amount: number; categoryId: string | null }>) {
    // Uncategorized rows and split parents (category NULL by construction)
    // touch no budget number; tracking rows were excluded by on_budget.
    if (row.categoryId === null) continue;
    const month = monthOfDate(row.date);
    if (row.categoryId === INFLOW_READY_TO_ASSIGN_CATEGORY_ID) {
      inflowsByMonth.set(month, milliunits((inflowsByMonth.get(month) ?? 0) + row.amount));
    } else {
      const key = categoryMonthKey(row.categoryId, month);
      activity.set(key, milliunits((activity.get(key) ?? 0) + row.amount));
    }
  }

  const assigned = new Map<string, Milliunits>();
  for (const row of db
    .prepare('SELECT category_id AS categoryId, month, assigned_milliunits AS amount FROM month_assignments')
    .iterate() as IterableIterator<{ categoryId: string; month: string; amount: number }>) {
    const key = categoryMonthKey(row.categoryId, row.month);
    assigned.set(key, milliunits((assigned.get(key) ?? 0) + row.amount));
  }

  return { categoryIds, activity, assigned, inflowsByMonth };
}

/** Pure month-by-month comparison; returns one message per differing value. */
export function diffBudgets(
  a: Map<string, MonthValues>,
  b: Map<string, MonthValues>,
): string[] {
  const mismatches: string[] = [];
  const months = new Set([...a.keys(), ...b.keys()]);
  for (const month of [...months].sort()) {
    const left = a.get(month);
    const right = b.get(month);
    if (!left || !right) {
      mismatches.push(`${month}: present in one computation only`);
      continue;
    }
    const compare = (label: string, x: number, y: number): void => {
      if (x !== y) mismatches.push(`${month} ${label}: ${x} vs ${y}`);
    };
    compare('RTA', left.rtaMilliunits, right.rtaMilliunits);
    compare('inflows', left.inflowsMilliunits, right.inflowsMilliunits);
    compare('assignedTotal', left.assignedTotalMilliunits, right.assignedTotalMilliunits);
    compare('overspendDeducted', left.overspendDeductedMilliunits, right.overspendDeductedMilliunits);
    const categoryIds = new Set([...left.categories.keys(), ...right.categories.keys()]);
    for (const categoryId of categoryIds) {
      const lc = left.categories.get(categoryId);
      const rc = right.categories.get(categoryId);
      if (!lc || !rc) {
        mismatches.push(`${month} category ${categoryId}: present in one computation only`);
        continue;
      }
      compare(`${categoryId} carryover`, lc.carryoverMilliunits, rc.carryoverMilliunits);
      compare(`${categoryId} assigned`, lc.assignedMilliunits, rc.assignedMilliunits);
      compare(`${categoryId} activity`, lc.activityMilliunits, rc.activityMilliunits);
      compare(`${categoryId} available`, lc.availableMilliunits, rc.availableMilliunits);
    }
  }
  return mismatches;
}

/**
 * Account working/cleared balances (E7.S4 AC-1): path A is the serving SQL
 * SUM (same shape as ledger/accounts.ts — parent_id IS NULL, cleared =
 * cleared|reconciled); path B walks individual rows and adds in memory.
 */
function diffAccountBalances(db: Database.Database): { mismatches: string[]; checked: number } {
  interface Sums {
    working: number;
    cleared: number;
  }
  const sqlSums = new Map<string, Sums>();
  for (const row of db
    .prepare(
      `SELECT a.id,
              COALESCE(SUM(t.amount_milliunits), 0) AS working,
              COALESCE(SUM(CASE WHEN t.status IN ('cleared', 'reconciled')
                                THEN t.amount_milliunits ELSE 0 END), 0) AS cleared
       FROM accounts a
       LEFT JOIN transactions t ON t.account_id = a.id AND t.parent_id IS NULL
       GROUP BY a.id`,
    )
    .iterate() as IterableIterator<{ id: string } & Sums>) {
    sqlSums.set(row.id, { working: row.working, cleared: row.cleared });
  }

  const walkSums = new Map<string, Sums>();
  for (const row of db.prepare('SELECT id FROM accounts').iterate() as IterableIterator<{
    id: string;
  }>) {
    walkSums.set(row.id, { working: 0, cleared: 0 });
  }
  for (const row of db
    .prepare(
      `SELECT account_id AS accountId, amount_milliunits AS amount, status
       FROM transactions WHERE parent_id IS NULL`,
    )
    .iterate() as IterableIterator<{ accountId: string; amount: number; status: string }>) {
    const sums = walkSums.get(row.accountId);
    if (!sums) continue; // orphan rows are impossible under the FK; SQL path would also miss them
    sums.working = milliunits(sums.working + row.amount);
    if (row.status === 'cleared' || row.status === 'reconciled') {
      sums.cleared = milliunits(sums.cleared + row.amount);
    }
  }

  const mismatches: string[] = [];
  for (const [accountId, sql] of sqlSums) {
    const walk = walkSums.get(accountId) ?? { working: 0, cleared: 0 };
    if (sql.working !== walk.working) {
      mismatches.push(`account ${accountId} working: ${sql.working} vs ${walk.working}`);
    }
    if (sql.cleared !== walk.cleared) {
      mismatches.push(`account ${accountId} cleared: ${sql.cleared} vs ${walk.cleared}`);
    }
  }
  return { mismatches, checked: sqlSums.size };
}

/**
 * Raw-row invariants the aggregations trust (E7.S4 AC-5). A tampered split
 * line changes a category's activity without changing its parent's account
 * total — both aggregation paths read the same corrupted line, so only the
 * FR-15 children-sum-to-parent invariant can catch and PINPOINT it.
 */
function checkRowInvariants(db: Database.Database): string[] {
  const mismatches: string[] = [];

  for (const row of db
    .prepare(
      `SELECT p.id, p.amount_milliunits AS parentAmount,
              COALESCE(SUM(l.amount_milliunits), 0) AS lineSum
       FROM transactions p
       JOIN transactions l ON l.parent_id = p.id
       GROUP BY p.id`,
    )
    .iterate() as IterableIterator<{ id: string; parentAmount: number; lineSum: number }>) {
    if (row.parentAmount !== row.lineSum) {
      mismatches.push(
        `split parent ${row.id}: lines sum to ${row.lineSum} vs parent total ${row.parentAmount}`,
      );
    }
  }

  // FR-16: a transfer is exactly two rows whose amounts cancel. (Transfers are
  // never split lines — split_transfer_not_supported — so no overlap above.)
  for (const row of db
    .prepare(
      `SELECT transfer_id AS transferId, COUNT(*) AS sides,
              COALESCE(SUM(amount_milliunits), 0) AS total
       FROM transactions WHERE transfer_id IS NOT NULL
       GROUP BY transfer_id`,
    )
    .iterate() as IterableIterator<{ transferId: string; sides: number; total: number }>) {
    if (row.sides !== 2) {
      mismatches.push(`transfer ${row.transferId}: ${row.sides} rows, expected 2`);
    } else if (row.total !== 0) {
      mismatches.push(`transfer ${row.transferId}: sides sum to ${row.total}, expected 0`);
    }
  }

  return mismatches;
}

export function runConsistencyCheck(
  db: Database.Database,
  throughMonth: string,
): ConsistencyReport {
  const sqlPath = computeBudget(loadEngineInputs(db), throughMonth);
  const walkPath = computeBudget(walkRawRows(db), throughMonth);
  const accounts = diffAccountBalances(db);
  const mismatches = [
    ...diffBudgets(sqlPath, walkPath),
    ...accounts.mismatches,
    ...checkRowInvariants(db),
  ];
  return {
    ok: mismatches.length === 0,
    mismatches,
    checkedAccounts: accounts.checked,
    checkedMonths: sqlPath.size,
  };
}
