/**
 * Money = signed integer milliunits of CAD (1/1000 dollar), per ADR-004 / FR-32.
 *
 * This file is the ONE audited module where arithmetic beyond +/- on money is
 * permitted (the eslint money rule bans `*`, `/`, `%` and float literals in the
 * domain modules — see eslint.config.js, AC-5 of E1.S1). Parse and format live
 * here so binary floating point never touches an amount: all conversion is done
 * on strings and integers.
 */

declare const MilliunitsBrand: unique symbol;

/** Branded integer so amounts cannot mix with ordinary numbers (ADR-004). */
export type Milliunits = number & { readonly [MilliunitsBrand]: true };

export const MILLIUNITS_PER_CENT = 10;
export const MILLIUNITS_PER_DOLLAR = 1000;

/** Smart constructor: the only blessed way to claim a number is money. */
export function milliunits(value: number): Milliunits {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`Milliunits must be a safe integer, got: ${value}`);
  }
  return value as Milliunits;
}

export function addMilliunits(a: Milliunits, b: Milliunits): Milliunits {
  return milliunits(a + b);
}

export function subtractMilliunits(a: Milliunits, b: Milliunits): Milliunits {
  return milliunits(a - b);
}

const DOLLARS_PATTERN = /^(-)?(\d+)(?:\.(\d{1,3}))?$/;

/**
 * Parse a user-entered dollar amount ("-138.93") to milliunits.
 * String-based — the input never exists as a binary float (ADR-004).
 * Rejects sub-cent precision: user input must be whole cents.
 */
export function parseDollarsToMilliunits(input: string): Milliunits {
  const match = DOLLARS_PATTERN.exec(input.trim());
  if (!match) {
    throw new Error(`Not a dollar amount: "${input}"`);
  }
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > 2) {
    throw new Error(`Sub-cent precision is not accepted (whole cents only): "${input}"`);
  }
  const fractionMilliunits = Number(fraction.padEnd(3, '0')); // "93" -> 930
  const magnitude = Number(whole) * MILLIUNITS_PER_DOLLAR + fractionMilliunits;
  return milliunits(sign === '-' ? -magnitude : magnitude);
}

/**
 * Format milliunits as a plain dollars string ("-138.93"), rounding half away
 * from zero to whole cents. Integer math only.
 */
export function formatMilliunits(amount: Milliunits): string {
  const negative = amount < 0;
  const magnitude = Math.abs(amount);
  // round half away from zero to the nearest cent
  const cents = Math.trunc((magnitude + MILLIUNITS_PER_CENT / 2) / MILLIUNITS_PER_CENT);
  const dollars = Math.trunc(cents / 100);
  const remainder = cents % 100;
  const text = `${dollars}.${String(remainder).padStart(2, '0')}`;
  return negative && cents > 0 ? `-${text}` : text;
}
