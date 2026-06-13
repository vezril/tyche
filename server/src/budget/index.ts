import type Database from 'better-sqlite3';
import type { CategorySummary } from '@tyche/shared';

/**
 * budget module (ADR-001): categories, groups, monthly assignments, RTA,
 * rollover (FR-1..9). The E3.S1 engine recomputes every derived number from
 * raw transactions + assignments on read (ADR-005) — see engine.ts for the
 * audited fold and queries.ts for the SQL seam.
 *
 * Boundary rules (enforced by eslint, AC-5): budget never imports from
 * importing/auth/admin/web and never sees a transaction's source (FR-25).
 */

export { BudgetError, type BudgetErrorCode } from './errors.js';
export {
  categoryMonthKey,
  computeBudget,
  type CategoryMonthValues,
  type EngineInput,
  type MonthValues,
} from './engine.js';
export { moveMoney, setAssignedAmount } from './assignments.js';
export {
  createCategory,
  createGroup,
  deleteCategory,
  deleteGroup,
  getCategoryStructure,
  updateCategory,
  updateGroup,
  type CategoryPatch,
  type GroupPatch,
} from './categories.js';
export { getBudgetMonth } from './grid.js';
// Raw engine inputs — consumed by the migration parity check (E6.S2 AC-2),
// which must cover HIDDEN categories too and so cannot use getBudgetMonth.
export { loadEngineInputs, type RawBudgetInputs } from './queries.js';
export { diffBudgets, runConsistencyCheck, type ConsistencyReport } from './consistency.js';

/** Visible categories for selection, system categories included (FR-19, architecture §5). */
export function listCategories(db: Database.Database): CategorySummary[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.group_id, g.name AS group_name, c.is_system
       FROM categories c
       JOIN category_groups g ON g.id = c.group_id
       WHERE c.hidden = 0
       ORDER BY g.sort_order, c.sort_order, c.name`,
    )
    .all() as {
    id: string;
    name: string;
    group_id: string;
    group_name: string;
    is_system: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    groupId: r.group_id,
    groupName: r.group_name,
    isSystem: r.is_system === 1,
  }));
}
