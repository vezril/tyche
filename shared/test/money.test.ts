import { describe, expect, it } from 'vitest';
import {
  addMilliunits,
  formatMilliunits,
  milliunits,
  parseDollarsToMilliunits,
  subtractMilliunits,
} from '../src/index.js';

// ADR-004: money is signed integer milliunits, exact arithmetic, parse/format only at the edges.

describe('milliunits smart constructor', () => {
  it('brands an integer amount', () => {
    expect(milliunits(-138930)).toBe(-138930);
  });

  it('rejects non-integers (no float money, FR-32)', () => {
    expect(() => milliunits(1.5)).toThrow(/integer/i);
  });

  it('rejects unsafe integers', () => {
    expect(() => milliunits(Number.MAX_SAFE_INTEGER + 2)).toThrow(/integer/i);
  });

  it('rejects NaN and Infinity', () => {
    expect(() => milliunits(Number.NaN)).toThrow(/integer/i);
    expect(() => milliunits(Number.POSITIVE_INFINITY)).toThrow(/integer/i);
  });
});

describe('addMilliunits / subtractMilliunits', () => {
  it('adds exactly', () => {
    expect(addMilliunits(milliunits(100), milliunits(-250))).toBe(-150);
  });

  it('sums many values exactly (FR-32 verification shape)', () => {
    const values = Array.from({ length: 10_000 }, (_, i) => milliunits((i % 7) * 10 - 30));
    const total = values.reduce((acc, v) => addMilliunits(acc, v), milliunits(0));
    // computed independently: each full cycle of 7 sums to 0+(-20)+(-10)+0+10+20+30 = 30... recompute below
    let expected = 0;
    for (let i = 0; i < 10_000; i++) expected += (i % 7) * 10 - 30;
    expect(total).toBe(expected);
  });

  it('subtracts exactly', () => {
    expect(subtractMilliunits(milliunits(1000), milliunits(1))).toBe(999);
  });
});

describe('parseDollarsToMilliunits (string-based, never via float)', () => {
  it('parses whole dollars', () => {
    expect(parseDollarsToMilliunits('12')).toBe(12_000);
  });

  it('parses dollars and cents', () => {
    expect(parseDollarsToMilliunits('-138.93')).toBe(-138_930);
  });

  it('parses a single decimal digit as tens of cents', () => {
    expect(parseDollarsToMilliunits('0.5')).toBe(500);
  });

  it('parses a float-hostile value exactly', () => {
    // 0.1 + 0.2 style values must not round-trip through binary floats
    expect(parseDollarsToMilliunits('0.30')).toBe(300);
  });

  it('rejects sub-cent input (whole-cent validation, ADR-004)', () => {
    expect(() => parseDollarsToMilliunits('1.234')).toThrow(/cent/i);
  });

  it('rejects garbage', () => {
    expect(() => parseDollarsToMilliunits('12abc')).toThrow();
    expect(() => parseDollarsToMilliunits('')).toThrow();
  });
});

describe('formatMilliunits (UI edge only)', () => {
  it('formats negative amounts', () => {
    expect(formatMilliunits(milliunits(-138930))).toBe('-138.93');
  });

  it('formats zero', () => {
    expect(formatMilliunits(milliunits(0))).toBe('0.00');
  });

  it('rounds half away from zero to whole cents using integer math', () => {
    expect(formatMilliunits(milliunits(5))).toBe('0.01');
    expect(formatMilliunits(milliunits(-5))).toBe('-0.01');
    expect(formatMilliunits(milliunits(4))).toBe('0.00');
  });

  it('round-trips parse → format for cent-precise values', () => {
    expect(formatMilliunits(parseDollarsToMilliunits('42.07'))).toBe('42.07');
  });
});
