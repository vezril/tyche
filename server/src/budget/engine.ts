import { milliunits, type Milliunits } from '@ynab-clone/shared';
import { earlierMonth, monthRange } from './month.js';

/**
 * THE audited budget fold (E3.S1, risk R4). One function owns every derived
 * budget number, per ADR-005's "concentrated in one function" mandate.
 *
 * Pure: inputs are pre-aggregated (category, month) sums plus per-month RTA
 * inflows; no I/O, no clock, no floats — integer milliunits in, integer
 * milliunits out (ADR-004). The PRD-locked recurrences (FR-1, FR-3, FR-8,
 * AS-1; architecture §5):
 *
 *   available(c, m) = carryover(c, m) + assigned(c, m) + activity(c, m)
 *   carryover(c, m) = max(0, available(c, m−1))         — negatives NEVER carry
 *   deduction(m)    = Σ_c max(0, −available(c, m−1))    — last month's cash
 *                     overspends, charged to THIS month's RTA exactly once
 *   RTA(m)          = Σ_{m'≤m} inflows(m') − Σ_{m'≤m} assignedTotal(m')
 *                     − Σ_{m'≤m} deduction(m')
 *
 * "Month rollover" is therefore pure derivation — no rollover job exists.
 */

/** Composite map key; ' ' cannot appear in ids or months. */
export function categoryMonthKey(categoryId: string, month: string): string {
  return `${categoryId} ${month}`;
}

export interface EngineInput {
  /**
   * Envelope categories — every category EXCEPT the system Inflow: Ready to
   * Assign category, whose transactions arrive as `inflowsByMonth` instead.
   */
  categoryIds: readonly string[];
  /** Σ on-budget transaction-line amounts per categoryMonthKey (FR-1, FR-10). */
  activity: ReadonlyMap<string, Milliunits>;
  /** Stored assignments per categoryMonthKey (the only other budget input). */
  assigned: ReadonlyMap<string, Milliunits>;
  /** Σ on-budget inflows categorized to Inflow: Ready to Assign, per month. */
  inflowsByMonth: ReadonlyMap<string, Milliunits>;
}

export interface CategoryMonthValues {
  carryoverMilliunits: Milliunits;
  assignedMilliunits: Milliunits;
  activityMilliunits: Milliunits;
  availableMilliunits: Milliunits;
}

export interface MonthValues {
  month: string;
  categories: Map<string, CategoryMonthValues>;
  inflowsMilliunits: Milliunits;
  /** Σ assigned across ALL envelope categories this month. */
  assignedTotalMilliunits: Milliunits;
  /** Prior month's cash overspends charged to this month's RTA (≥ 0, AS-1). */
  overspendDeductedMilliunits: Milliunits;
  rtaMilliunits: Milliunits;
}

const ZERO = milliunits(0);

/** Earliest month named anywhere in the input, or undefined when empty. */
function earliestInputMonth(input: EngineInput): string | undefined {
  let earliest: string | undefined;
  const consider = (month: string): void => {
    if (earliest === undefined || month < earliest) earliest = month;
  };
  for (const key of input.activity.keys()) consider(key.slice(-7));
  for (const key of input.assigned.keys()) consider(key.slice(-7));
  for (const month of input.inflowsByMonth.keys()) consider(month);
  return earliest;
}

/**
 * Fold every month from the earliest input month (or `throughMonth`, whichever
 * is earlier) through `throughMonth`, inclusive. Every month in that range is
 * present in the result — zero-row months included, because carryover and RTA
 * flow through them (FR-8 has no gaps).
 */
export function computeBudget(input: EngineInput, throughMonth: string): Map<string, MonthValues> {
  const startMonth = earlierMonth(earliestInputMonth(input) ?? throughMonth, throughMonth);
  const result = new Map<string, MonthValues>();

  let previous: Map<string, CategoryMonthValues> | undefined;
  let cumulativeRta = 0;

  for (const month of monthRange(startMonth, throughMonth)) {
    const categories = new Map<string, CategoryMonthValues>();
    let assignedTotal = 0;
    let overspendDeducted = 0;

    for (const categoryId of input.categoryIds) {
      const previousAvailable = previous?.get(categoryId)?.availableMilliunits ?? ZERO;
      const carryover = previousAvailable > 0 ? previousAvailable : 0;
      if (previousAvailable < 0) overspendDeducted -= previousAvailable; // AS-1
      const assigned = input.assigned.get(categoryMonthKey(categoryId, month)) ?? ZERO;
      const activity = input.activity.get(categoryMonthKey(categoryId, month)) ?? ZERO;
      assignedTotal += assigned;
      categories.set(categoryId, {
        carryoverMilliunits: milliunits(carryover),
        assignedMilliunits: assigned,
        activityMilliunits: activity,
        availableMilliunits: milliunits(carryover + assigned + activity), // FR-1
      });
    }

    const inflows = input.inflowsByMonth.get(month) ?? ZERO;
    cumulativeRta += inflows - assignedTotal - overspendDeducted; // FR-3

    result.set(month, {
      month,
      categories,
      inflowsMilliunits: inflows,
      assignedTotalMilliunits: milliunits(assignedTotal),
      overspendDeductedMilliunits: milliunits(overspendDeducted),
      rtaMilliunits: milliunits(cumulativeRta),
    });
    previous = categories;
  }

  return result;
}
