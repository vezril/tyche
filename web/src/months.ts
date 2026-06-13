/**
 * 'YYYY-MM' month math for the budget grid's navigation (E3.S2, FR-2).
 *
 * Mirrors the server's discipline (server/src/budget/month.ts): the string
 * form sorts chronologically, so comparison is plain string comparison and
 * only prev/next need integer arithmetic with a year carry. No Date objects —
 * no timezone edge can ever shift a month.
 */

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isValidMonth(value: string): boolean {
  return MONTH_PATTERN.test(value);
}

/** The browser's current month as 'YYYY-MM' (local clock, ISO date form). */
export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export function nextMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const nextYear = m === 12 ? year + 1 : year;
  const next = m === 12 ? 1 : m + 1;
  return `${String(nextYear).padStart(4, '0')}-${String(next).padStart(2, '0')}`;
}

export function prevMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const prevYear = m === 1 ? year - 1 : year;
  const prev = m === 1 ? 12 : m - 1;
  return `${String(prevYear).padStart(4, '0')}-${String(prev).padStart(2, '0')}`;
}

/** Clamp into the navigable [min..max] bounds the server reports (FR-2). */
export function clampMonth(month: string, min: string, max: string): string {
  if (month < min) return min;
  if (month > max) return max;
  return month;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** '2026-06' → 'June 2026' for the grid header. */
export function monthLabel(month: string): string {
  const name = MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? month;
  return `${name} ${month.slice(0, 4)}`;
}
