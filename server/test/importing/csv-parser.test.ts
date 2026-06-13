import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectFormat, ImportError, parseRbcCsv } from '../../src/importing/index.js';

/**
 * E4.S1 AC-2: the RBC CSV parser against the real export format ("Account
 * Type, Account Number, Transaction Date, Cheque Number, Description 1,
 * Description 2, CAD$, USD$"), M/D/YYYY dates, quoted descriptions containing
 * commas, thousands-separated amounts, and per-row error reporting (AC-3).
 * Amounts are parsed via strings — never a float (FR-32, ADR-004).
 */

const FIXTURE = readFileSync(join(import.meta.dirname, 'fixtures/rbc-chequing.csv'), 'utf8');

describe('RBC CSV parser (E4.S1)', () => {
  const { staged, errors } = parseRbcCsv(FIXTURE);

  it('parses every valid data row', () => {
    expect(staged).toHaveLength(8);
  });

  it('AC-2: M/D/YYYY dates, payees, and signed milliunit amounts parse correctly', () => {
    expect(staged[0]).toMatchObject({
      date: '2026-06-01',
      payee: 'TIM HORTONS #2241',
      memo: 'COFFEE',
      amountMilliunits: -52160,
      externalId: null, // RBC CSV has no stable id — dedup is content-based (S3)
    });
    const rent = staged.find((t) => t.payee === 'E-TRF SENT');
    expect(rent).toMatchObject({ date: '2026-05-30', amountMilliunits: -1200000 });
  });

  it('parses inflows as positive amounts', () => {
    const payroll = staged.find((t) => t.payee === 'PAYROLL DEPOSIT');
    expect(payroll?.amountMilliunits).toBe(2417330);
  });

  it('handles quoted descriptions containing commas', () => {
    const amazon = staged.find((t) => t.payee === 'AMZN Mktp CA, ORDER #701-22');
    expect(amazon).toMatchObject({ date: '2026-06-07', amountMilliunits: -63400 });
  });

  it('strips thousands separators inside quoted amounts', () => {
    const car = staged.find((t) => t.payee === 'CAR PAYMENT RBC LOAN');
    expect(car?.amountMilliunits).toBe(-1977210);
  });

  it('carries the cheque number into the memo', () => {
    const cheque = staged.find((t) => t.payee === 'CHEQUE');
    expect(cheque?.memo).toBe('Cheque #123');
  });

  it('AC-3: USD-only and bad-date rows are reported per-row with reasons', () => {
    expect(errors).toHaveLength(2);
    const reasons = errors.map((e) => e.reason).join(' ');
    expect(reasons).toMatch(/CAD\$/); // USD-side row refused, not guessed at
    expect(reasons).toMatch(/Transaction Date/);
    expect(errors.map((e) => e.line)).toEqual([10, 11]); // 1-based, header = line 1
  });

  it('matches header columns by name, not position', () => {
    const reordered = [
      '"Transaction Date","Description 1","CAD$"',
      '6/1/2026,"SHUFFLED COLUMNS",-1.00',
    ].join('\n');
    const result = parseRbcCsv(reordered);
    expect(result.staged).toEqual([
      expect.objectContaining({ date: '2026-06-01', payee: 'SHUFFLED COLUMNS', amountMilliunits: -1000 }),
    ]);
  });

  it('rejects a file without the RBC columns as unsupported_format', () => {
    expect(() => parseRbcCsv('a,b,c\n1,2,3')).toThrowError(ImportError);
  });

  it('is detected as CSV by extension and by header sniff', () => {
    expect(detectFormat('june.csv', '')).toBe('csv');
    expect(detectFormat('renamed.txt', FIXTURE)).toBe('csv');
    expect(() => detectFormat('mystery.bin', 'garbage')).toThrowError(ImportError);
  });
});
