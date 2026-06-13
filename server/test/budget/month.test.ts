import { describe, expect, it } from 'vitest';
import {
  compareMonths,
  isValidMonth,
  laterMonth,
  monthOfDate,
  monthRange,
  nextMonth,
} from '../../src/budget/month.js';

// E3.S1: 'YYYY-MM' month arithmetic. String-based and integer-only — these
// helpers underpin the fold's month enumeration, so the year boundary and
// validation edges get their own tests.

describe('month helpers (E3.S1)', () => {
  it('validates YYYY-MM strictly (01–12 only)', () => {
    expect(isValidMonth('2026-06')).toBe(true);
    expect(isValidMonth('2026-01')).toBe(true);
    expect(isValidMonth('2026-12')).toBe(true);
    expect(isValidMonth('2026-13')).toBe(false);
    expect(isValidMonth('2026-00')).toBe(false);
    expect(isValidMonth('2026-6')).toBe(false);
    expect(isValidMonth('2026-06-01')).toBe(false);
    expect(isValidMonth('june')).toBe(false);
  });

  it('nextMonth increments and rolls the year boundary', () => {
    expect(nextMonth('2026-06')).toBe('2026-07');
    expect(nextMonth('2026-12')).toBe('2027-01');
    expect(nextMonth('1999-12')).toBe('2000-01');
  });

  it('monthOfDate truncates an ISO date', () => {
    expect(monthOfDate('2026-06-12')).toBe('2026-06');
  });

  it('compareMonths orders chronologically and laterMonth picks the max', () => {
    expect(compareMonths('2026-01', '2026-02')).toBeLessThan(0);
    expect(compareMonths('2026-02', '2026-02')).toBe(0);
    expect(compareMonths('2027-01', '2026-12')).toBeGreaterThan(0);
    expect(laterMonth('2026-12', '2027-01')).toBe('2027-01');
    expect(laterMonth('2027-01', '2026-12')).toBe('2027-01');
  });

  it('monthRange enumerates inclusive ranges across years', () => {
    expect(monthRange('2026-11', '2027-02')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
    expect(monthRange('2026-06', '2026-06')).toEqual(['2026-06']);
  });
});
