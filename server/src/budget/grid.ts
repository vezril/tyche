import type Database from 'better-sqlite3';
import type {
  BudgetCategoryMonth,
  BudgetGroupMonth,
  BudgetMonthResponse,
} from '@tyche/shared';
import { BudgetError } from './errors.js';
import { computeBudget } from './engine.js';
import { earlierMonth, isValidMonth, laterMonth, monthOfDate, nextMonth } from './month.js';
import { listVisibleCategories, loadEngineInputs } from './queries.js';

/**
 * The month-grid read model (E3.S1 → consumed by E3.S2): load raw inputs, run
 * the audited fold through the requested month, project the visible groups
 * with rollups. Recomputed from raw rows on EVERY call (ADR-005) — measured
 * against the PRD ceiling by the AC-7 perf test.
 */
export function getBudgetMonth(
  db: Database.Database,
  month: string,
  todayIsoDate: string,
): BudgetMonthResponse {
  if (!isValidMonth(month)) throw new BudgetError('invalid_month');
  const currentMonth = monthOfDate(todayIsoDate);

  const inputs = loadEngineInputs(db);
  const folded = computeBudget(inputs, month);
  const values = folded.get(month)!;

  const groups: BudgetGroupMonth[] = [];
  let currentGroup: BudgetGroupMonth | undefined;
  for (const row of listVisibleCategories(db)) {
    if (!currentGroup || currentGroup.groupId !== row.groupId) {
      currentGroup = {
        groupId: row.groupId,
        name: row.groupName,
        assignedMilliunits: 0,
        activityMilliunits: 0,
        availableMilliunits: 0,
        categories: [],
      };
      groups.push(currentGroup);
    }
    const computed = values.categories.get(row.categoryId);
    const category: BudgetCategoryMonth = {
      categoryId: row.categoryId,
      name: row.categoryName,
      carryoverMilliunits: computed?.carryoverMilliunits ?? 0,
      assignedMilliunits: computed?.assignedMilliunits ?? 0,
      activityMilliunits: computed?.activityMilliunits ?? 0,
      availableMilliunits: computed?.availableMilliunits ?? 0,
    };
    currentGroup.categories.push(category);
    currentGroup.assignedMilliunits += category.assignedMilliunits;
    currentGroup.activityMilliunits += category.activityMilliunits;
    currentGroup.availableMilliunits += category.availableMilliunits;
  }

  return {
    month,
    rtaMilliunits: values.rtaMilliunits,
    inflowsMilliunits: values.inflowsMilliunits,
    assignedThisMonthMilliunits: values.assignedTotalMilliunits,
    overspendDeductedMilliunits: values.overspendDeductedMilliunits,
    groups,
    bounds: {
      // Earliest transaction/assignment month (never later than today's month) …
      minMonth: earlierMonth(inputs.earliestDataMonth ?? currentMonth, currentMonth),
      // … through one month past the latest of (data, today) — the "+1 future
      // month" the grid can navigate into for planning ahead.
      maxMonth: nextMonth(laterMonth(inputs.latestDataMonth ?? currentMonth, currentMonth)),
    },
  };
}
