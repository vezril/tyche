import { describe, expect, it } from 'vitest';
import {
  parsePlanCsv,
  parseRegisterCsv,
  parseYnabAmount,
  parseYnabDate,
  parseYnabMonth,
} from '../../src/migration/index.js';

/**
 * E6.S1 AC-2/AC-6 ground layer: tolerant, string-only parsing of YNAB's two
 * export CSVs. Locale-formatted dollar strings ("C$1,234.56") must round-trip
 * to integer milliunits without ever existing as a binary float (ADR-004,
 * FR-32); malformed rows surface as per-line issues, never throws.
 */

describe('parseYnabAmount (locale-formatted dollars → milliunits)', () => {
  it.each([
    ['C$1,234.56', 1_234_560],
    ['$1,234.56', 1_234_560],
    ['1234.56', 1_234_560],
    ['CA$2.50', 2_500],
    ['CAD 12.00', 12_000],
    ['C$0.00', 0],
    ['-C$138.93', -138_930],
    ['C$-138.93', -138_930],
    ['($45.00)', -45_000],
    ['−C$5.00', -5_000], // unicode minus
    ['  C$7.01  ', 7_010],
    ['12,345,678.90', 12_345_678_900],
    ['42', 42_000],
  ])('parses %s', (raw, expected) => {
    expect(parseYnabAmount(raw)).toBe(expected);
  });

  it.each(['', 'abc', 'C$', '1.2.3', '12.345', '--5.00'])('rejects %j with null', (raw) => {
    expect(parseYnabAmount(raw)).toBeNull();
  });
});

describe('parseYnabDate', () => {
  it('accepts ISO dates', () => {
    expect(parseYnabDate('2026-06-12')).toBe('2026-06-12');
  });
  it('accepts M/D/YYYY (YNAB US default)', () => {
    expect(parseYnabDate('6/1/2026')).toBe('2026-06-01');
  });
  it('disambiguates D/M/YYYY when the first number cannot be a month', () => {
    expect(parseYnabDate('25/03/2026')).toBe('2026-03-25');
  });
  it('rejects impossible dates', () => {
    expect(parseYnabDate('2026-02-30')).toBeNull();
    expect(parseYnabDate('13/13/2026')).toBeNull();
    expect(parseYnabDate('not a date')).toBeNull();
  });
});

describe('parseYnabMonth', () => {
  it.each([
    ['2026-06', '2026-06'],
    ['2026-06-01', '2026-06'],
    ['Jun 2026', '2026-06'],
    ['December 2025', '2025-12'],
  ])('parses %s → %s', (raw, expected) => {
    expect(parseYnabMonth(raw)).toBe(expected);
  });
  it('rejects garbage', () => {
    expect(parseYnabMonth('Junk 2026')).toBeNull();
    expect(parseYnabMonth('2026')).toBeNull();
  });
});

const REGISTER_HEADER =
  '"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"';

describe('parseRegisterCsv', () => {
  it('parses a quoted row with locale amounts into signed milliunits', () => {
    const { rows, issues } = parseRegisterCsv(
      [
        REGISTER_HEADER,
        '"Spending Account","","2026-06-02","Save-On-Foods","Variable Spending: Groceries","Variable Spending","Groceries","weekly, ""big"" run","C$123.45","C$0.00","Cleared"',
      ].join('\n'),
    );
    expect(issues).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      line: 2,
      account: 'Spending Account',
      date: '2026-06-02',
      payee: 'Save-On-Foods',
      categoryGroup: 'Variable Spending',
      category: 'Groceries',
      memo: 'weekly, "big" run',
      amountMilliunits: -123_450,
      status: 'cleared',
    });
  });

  it('maps Cleared/Uncleared/Reconciled case-insensitively', () => {
    const { rows } = parseRegisterCsv(
      [
        REGISTER_HEADER,
        '"A","","2026-06-02","P","","","","","C$1.00","C$0.00","RECONCILED"',
        '"A","","2026-06-02","P","","","","","C$1.00","C$0.00","uncleared"',
      ].join('\n'),
    );
    expect(rows.map((r) => r.status)).toEqual(['reconciled', 'uncleared']);
  });

  it('falls back to the combined Category Group/Category column when split columns are absent', () => {
    const { rows } = parseRegisterCsv(
      [
        '"Account","Flag","Date","Payee","Category Group/Category","Memo","Outflow","Inflow","Cleared"',
        '"A","","2026-06-02","Employer","Inflow: Ready to Assign","","C$0.00","C$1,000.00","Cleared"',
        '"A","","2026-06-03","Store","Variable Spending: Groceries","","C$20.00","C$0.00","Cleared"',
      ].join('\n'),
    );
    expect(rows[0]).toMatchObject({ categoryGroup: 'Inflow', category: 'Ready to Assign' });
    expect(rows[1]).toMatchObject({ categoryGroup: 'Variable Spending', category: 'Groceries' });
  });

  it('reports malformed rows as issues without dropping the rest (FR-31)', () => {
    const { rows, issues } = parseRegisterCsv(
      [
        REGISTER_HEADER,
        '"A","","2026-06-02","P","","","","","C$1.00","C$0.00","Cleared"',
        '"A","","junk-date","P","","","","","C$1.00","C$0.00","Cleared"',
        '"A","","2026-06-04","P","","","","","not-money","C$0.00","Cleared"',
        '"A","","2026-06-05","P","","","","","C$1.00","C$0.00","Mystery"',
      ].join('\n'),
    );
    expect(rows.map((r) => r.line)).toEqual([2, 5]);
    expect(issues.map((i) => i.line)).toEqual([3, 4, 5]);
    expect(issues[0]!.reason).toContain('date');
    expect(issues[1]!.reason).toContain('amount');
    // Unknown cleared value: imported anyway (as uncleared) but reported.
    expect(rows[1]!.status).toBe('uncleared');
    expect(issues[2]!.reason).toContain('Cleared');
  });

  it('throws unsupported_format when required columns are missing', () => {
    expect(() => parseRegisterCsv('"Nope","Columns"\n"a","b"')).toThrowError(
      /register/i,
    );
  });
});

describe('parsePlanCsv', () => {
  const HEADER =
    '"Month","Category Group/Category","Category Group","Category","Budgeted","Activity","Available"';

  it('parses month, names and the three milliunit amounts', () => {
    const { rows, issues } = parsePlanCsv(
      [
        HEADER,
        '"Jun 2026","Variable Spending: Groceries","Variable Spending","Groceries","C$600.00","-C$138.93","C$461.07"',
      ].join('\n'),
    );
    expect(issues).toEqual([]);
    expect(rows[0]).toMatchObject({
      line: 2,
      month: '2026-06',
      categoryGroup: 'Variable Spending',
      category: 'Groceries',
      budgetedMilliunits: 600_000,
      activityMilliunits: -138_930,
      availableMilliunits: 461_070,
    });
  });

  it('reports rows with bad months or amounts as issues', () => {
    const { rows, issues } = parsePlanCsv(
      [
        HEADER,
        '"Nonsense","G: C","G","C","C$1.00","C$0.00","C$1.00"',
        '"Jun 2026","G: C","G","C","wat","C$0.00","C$1.00"',
        '"Jun 2026","G: C","G","C","C$1.00","C$0.00","C$1.00"',
      ].join('\n'),
    );
    expect(rows).toHaveLength(1);
    expect(issues.map((i) => i.line)).toEqual([2, 3]);
  });

  it('throws unsupported_format when required columns are missing', () => {
    expect(() => parsePlanCsv('"Nope"\n"x"')).toThrowError(/plan/i);
  });
});
