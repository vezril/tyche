import type Database from 'better-sqlite3';
import { milliunits, type Milliunits } from '@tyche/shared';
import { INFLOW_READY_TO_ASSIGN_CATEGORY_ID } from '../db/seed.js';
import { BudgetError } from './errors.js';
import { isValidMonth } from './month.js';

/**
 * MonthAssignment writes (FR-4): the ONLY stored budget input besides
 * transactions (ADR-005). An upsert, no aggregate maintenance — every derived
 * number is recomputed on the next read by construction.
 */
export function setAssignedAmount(
  db: Database.Database,
  categoryId: string,
  month: string,
  amountMilliunits: Milliunits,
): void {
  if (!isValidMonth(month)) throw new BudgetError('invalid_month');
  if (categoryId === INFLOW_READY_TO_ASSIGN_CATEGORY_ID) {
    // Money is assigned FROM the inflow pool, never TO it (FR-3).
    throw new BudgetError('cannot_assign_to_inflow_category');
  }
  const category = db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId);
  if (!category) throw new BudgetError('category_not_found');

  if (amountMilliunits === 0) {
    // Clearing a cell removes the row entirely: no zero-row residue to stretch
    // the month bounds or bloat exports.
    db.prepare('DELETE FROM month_assignments WHERE category_id = ? AND month = ?').run(
      categoryId,
      month,
    );
    return;
  }
  db.prepare(
    `INSERT INTO month_assignments (category_id, month, assigned_milliunits)
     VALUES (?, ?, ?)
     ON CONFLICT (category_id, month) DO UPDATE SET
       assigned_milliunits = excluded.assigned_milliunits,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).run(categoryId, month, amountMilliunits);
}

/** The stored assignment for (category, month), 0 when no row exists. */
function assignedAmount(db: Database.Database, categoryId: string, month: string): Milliunits {
  const row = db
    .prepare('SELECT assigned_milliunits AS amount FROM month_assignments WHERE category_id = ? AND month = ?')
    .get(categoryId, month) as { amount: number } | undefined;
  return milliunits(row?.amount ?? 0);
}

/**
 * Move available money category→category within a month (E3.S4, FR-5):
 * PAIRED assignment adjustments — source −amount, destination +amount — in
 * ONE SQLite transaction. No new entity, no engine change: the two deltas
 * cancel in the locked RTA formula (AS-1), so RTA is unchanged by
 * construction. Driving the source negative is permitted (FR-7: warn in the
 * UI, never block). Moves to/from RTA itself are a single assignment edit
 * (E3.S3) and are rejected here.
 */
export function moveMoney(
  db: Database.Database,
  month: string,
  fromCategoryId: string,
  toCategoryId: string,
  amountMilliunits: Milliunits,
): void {
  if (!isValidMonth(month)) throw new BudgetError('invalid_month');
  if (amountMilliunits <= 0) throw new BudgetError('move_amount_not_positive');
  if (fromCategoryId === toCategoryId) throw new BudgetError('move_requires_two_categories');

  // setAssignedAmount re-validates each side (existence + the inflow rule);
  // any throw rolls BOTH writes back — atomicity per AC-2.
  db.transaction(() => {
    setAssignedAmount(
      db,
      fromCategoryId,
      month,
      milliunits(assignedAmount(db, fromCategoryId, month) - amountMilliunits),
    );
    setAssignedAmount(
      db,
      toCategoryId,
      month,
      milliunits(assignedAmount(db, toCategoryId, month) + amountMilliunits),
    );
  })();
}
