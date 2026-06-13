import { describe, expect, it } from 'vitest';
import {
  clampMonth,
  currentMonth,
  isValidMonth,
  monthLabel,
  nextMonth,
  prevMonth,
} from '../src/months.js';

// Month-string navigation math for the grid header (E3.S2 AC-2, FR-2):
// pure string/integer arithmetic, year carries included — no Date objects.

describe('month navigation math (E3.S2)', () => {
  it('nextMonth advances with a year carry', () => {
    expect(nextMonth('2026-06')).toBe('2026-07');
    expect(nextMonth('2026-12')).toBe('2027-01');
    expect(nextMonth('1999-12')).toBe('2000-01');
  });

  it('prevMonth retreats with a year carry', () => {
    expect(prevMonth('2026-06')).toBe('2026-05');
    expect(prevMonth('2026-01')).toBe('2025-12');
    expect(prevMonth('2000-01')).toBe('1999-12');
  });

  it('prev and next are inverses across a year of months', () => {
    let month = '2025-11';
    for (let i = 0; i < 14; i += 1) {
      expect(prevMonth(nextMonth(month))).toBe(month);
      month = nextMonth(month);
    }
  });

  it('clampMonth pins to the navigable bounds (FR-2)', () => {
    expect(clampMonth('2026-06', '2026-01', '2026-12')).toBe('2026-06');
    expect(clampMonth('2025-03', '2026-01', '2026-12')).toBe('2026-01');
    expect(clampMonth('2031-07', '2026-01', '2026-12')).toBe('2026-12');
  });

  it('isValidMonth accepts YYYY-MM and rejects garbage', () => {
    expect(isValidMonth('2026-06')).toBe(true);
    expect(isValidMonth('2026-13')).toBe(false);
    expect(isValidMonth('2026-00')).toBe(false);
    expect(isValidMonth('2026-6')).toBe(false);
    expect(isValidMonth('')).toBe(false);
  });

  it('monthLabel renders a human header', () => {
    expect(monthLabel('2026-06')).toBe('June 2026');
    expect(monthLabel('2025-12')).toBe('December 2025');
  });

  it('currentMonth is a valid month string', () => {
    expect(isValidMonth(currentMonth())).toBe(true);
  });
});
