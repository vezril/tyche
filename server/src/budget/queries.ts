import type Database from 'better-sqlite3';
import { milliunits, type Milliunits } from '@ynab-clone/shared';
import { INFLOW_READY_TO_ASSIGN_CATEGORY_ID } from '../db/seed.js';
import { categoryMonthKey, type EngineInput } from './engine.js';

/**
 * The budget module's read seam over raw rows (ADR-005): one indexed
 * GROUP BY (category, month) for activity, one for RTA inflows, plus the
 * stored assignments. NOTE the deliberate blindness: no query here selects
 * `source` — budget math is provenance-independent (FR-25, ADR-001), and the
 * boundary lint keeps it that way.
 *
 * Split handling (E2.S4 contract): split PARENTS have category_id NULL and so
 * never enter these sums; split LINES carry category + date directly. Tracking
 * accounts are excluded by the on_budget join (FR-10). Transfer rows carry a
 * category only on the on-budget side of a mixed transfer (FR-16) — exactly
 * the side that must hit the budget.
 */

export interface RawBudgetInputs extends EngineInput {
  /** Earliest/latest month with any transaction or assignment; null when empty. */
  earliestDataMonth: string | null;
  latestDataMonth: string | null;
}

export function loadEngineInputs(db: Database.Database): RawBudgetInputs {
  const categoryIds = (
    db.prepare('SELECT id FROM categories WHERE id <> ? ORDER BY id').all(
      INFLOW_READY_TO_ASSIGN_CATEGORY_ID,
    ) as { id: string }[]
  ).map((r) => r.id);

  const activity = new Map<string, Milliunits>();
  for (const row of db
    .prepare(
      `SELECT t.category_id AS categoryId, substr(t.date, 1, 7) AS month,
              SUM(t.amount_milliunits) AS total
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       WHERE a.on_budget = 1 AND t.category_id IS NOT NULL AND t.category_id <> ?
       GROUP BY t.category_id, substr(t.date, 1, 7)`,
    )
    .iterate(INFLOW_READY_TO_ASSIGN_CATEGORY_ID) as IterableIterator<{
    categoryId: string;
    month: string;
    total: number;
  }>) {
    activity.set(categoryMonthKey(row.categoryId, row.month), milliunits(row.total));
  }

  const inflowsByMonth = new Map<string, Milliunits>();
  for (const row of db
    .prepare(
      `SELECT substr(t.date, 1, 7) AS month, SUM(t.amount_milliunits) AS total
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       WHERE a.on_budget = 1 AND t.category_id = ?
       GROUP BY substr(t.date, 1, 7)`,
    )
    .iterate(INFLOW_READY_TO_ASSIGN_CATEGORY_ID) as IterableIterator<{
    month: string;
    total: number;
  }>) {
    inflowsByMonth.set(row.month, milliunits(row.total));
  }

  const assigned = new Map<string, Milliunits>();
  for (const row of db
    .prepare('SELECT category_id AS categoryId, month, assigned_milliunits AS total FROM month_assignments')
    .iterate() as IterableIterator<{ categoryId: string; month: string; total: number }>) {
    assigned.set(categoryMonthKey(row.categoryId, row.month), milliunits(row.total));
  }

  const bounds = db
    .prepare(
      `SELECT
         MIN(m) AS earliest, MAX(m) AS latest
       FROM (
         SELECT substr(date, 1, 7) AS m FROM transactions
         UNION ALL
         SELECT month AS m FROM month_assignments
       )`,
    )
    .get() as { earliest: string | null; latest: string | null };

  return {
    categoryIds,
    activity,
    assigned,
    inflowsByMonth,
    earliestDataMonth: bounds.earliest,
    latestDataMonth: bounds.latest,
  };
}

/** Visible (non-hidden) groups and categories in grid display order (FR-2, FR-9). */
export interface VisibleCategoryRow {
  categoryId: string;
  categoryName: string;
  groupId: string;
  groupName: string;
}

export function listVisibleCategories(db: Database.Database): VisibleCategoryRow[] {
  return (
    db
      .prepare(
        `SELECT c.id AS categoryId, c.name AS categoryName, g.id AS groupId, g.name AS groupName
         FROM categories c
         JOIN category_groups g ON g.id = c.group_id
         WHERE c.hidden = 0 AND g.hidden = 0
         ORDER BY g.sort_order, g.name, c.sort_order, c.name`,
      )
      .all() as VisibleCategoryRow[]
  );
}
