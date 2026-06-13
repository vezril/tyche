import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectFormat, parseOfx } from '../../src/importing/index.js';

/**
 * E4.S1 AC-1: the tolerant minimal OFX 1.x (SGML) parser against a realistic
 * RBC chequing export — CAD, signed amounts, FITIDs, timezone-suffixed dates,
 * and the edge cases a real file throws: duplicate FITID, '+'-signed credits,
 * thousands commas, MEMO-only rows, and unparseable rows reported per-row
 * with reasons (AC-3).
 */

const FIXTURE = readFileSync(join(import.meta.dirname, 'fixtures/rbc-chequing.ofx'), 'utf8');

describe('OFX parser (E4.S1)', () => {
  const { staged, errors } = parseOfx(FIXTURE);

  it('parses every well-formed STMTTRN block (duplicate FITID rows included — dedup is the pipeline\'s job)', () => {
    expect(staged).toHaveLength(9);
  });

  it('AC-1: dates, payees, signed amounts, and FITID parse correctly', () => {
    expect(staged[0]).toMatchObject({
      date: '2026-06-01',
      payee: 'TIM HORTONS #2241',
      amountMilliunits: -52160, // outflow negative, integer milliunits (ADR-004)
      externalId: 'C1A0001',
      memo: 'POS PURCHASE',
      accountHint: null, // files carry no account mapping (AC-6)
    });
  });

  it('parses a credit with an explicit + sign', () => {
    const payroll = staged.find((t) => t.externalId === 'C1A0003');
    expect(payroll).toMatchObject({ date: '2026-06-05', amountMilliunits: 2417330 });
  });

  it('parses an unsigned credit as an inflow', () => {
    const etrf = staged.find((t) => t.externalId === 'C1A0007');
    expect(etrf?.amountMilliunits).toBe(45000);
  });

  it('strips thousands commas from TRNAMT (string-based, never a float)', () => {
    const car = staged.find((t) => t.externalId === 'C1A0010');
    expect(car?.amountMilliunits).toBe(-1977210);
  });

  it('accepts a plain YYYYMMDD DTPOSTED without time/zone suffix', () => {
    const netflix = staged.find((t) => t.externalId === 'C1A0006');
    expect(netflix?.date).toBe('2026-06-03');
  });

  it('falls back to MEMO as the payee when NAME is absent (bank fee rows)', () => {
    const fee = staged.find((t) => t.externalId === 'C1A0011');
    expect(fee).toMatchObject({ payee: 'MONTHLY FEE', amountMilliunits: -4000 });
  });

  it('AC-3: unparseable rows are reported per-row with reasons, valid rows still parse', () => {
    expect(errors).toHaveLength(2);
    expect(errors.map((e) => e.reason).join(' ')).toMatch(/TRNAMT.*FORTYTWO/);
    expect(errors.map((e) => e.reason).join(' ')).toMatch(/DTPOSTED/);
    for (const error of errors) expect(error.line).toBeGreaterThan(1);
  });

  it('is detected as OFX by extension and by content sniff', () => {
    expect(detectFormat('june.ofx', '')).toBe('ofx');
    expect(detectFormat('june.qfx', '')).toBe('ofx');
    expect(detectFormat('renamed.txt', FIXTURE)).toBe('ofx');
  });
});
