/**
 * 'YYYY-MM' month arithmetic for the budget fold (E3.S1, architecture §5).
 *
 * String-and-integer only (ADR-004 discipline): lexicographic order on the
 * 'YYYY-MM' form IS chronological order, so comparison is plain string
 * comparison and only nextMonth needs arithmetic (integer +1 with a year
 * carry — no banned operators).
 */

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isValidMonth(value: string): boolean {
  return MONTH_PATTERN.test(value);
}

/** 'YYYY-MM-DD' → 'YYYY-MM'. Dates are schema-validated upstream. */
export function monthOfDate(date: string): string {
  return date.slice(0, 7);
}

/** Negative / zero / positive, chronological. */
export function compareMonths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function laterMonth(a: string, b: string): string {
  return a > b ? a : b;
}

export function earlierMonth(a: string, b: string): string {
  return a < b ? a : b;
}

export function nextMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const nextYear = m === 12 ? year + 1 : year;
  const next = m === 12 ? 1 : m + 1;
  return `${String(nextYear).padStart(4, '0')}-${String(next).padStart(2, '0')}`;
}

/** Inclusive [from..to]; empty when from > to. */
export function monthRange(from: string, to: string): string[] {
  const months: string[] = [];
  for (let month = from; month <= to; month = nextMonth(month)) {
    months.push(month);
  }
  return months;
}
