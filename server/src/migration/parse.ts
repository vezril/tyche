import { milliunits, parseDollarsToMilliunits, type Milliunits } from '@ynab-clone/shared';
import type { TransactionStatus } from '@ynab-clone/shared';
import { readCsvTable, type CsvTable } from './csv.js';
import { MigrationError } from './errors.js';

/**
 * Parsers for YNAB's standard export pair (FR-30, AS-4):
 *
 *  - Register CSV: "Account","Flag","Date","Payee","Category Group/Category",
 *    "Category Group","Category","Memo","Outflow","Inflow","Cleared"
 *  - Plan CSV:     "Month","Category Group/Category","Category Group",
 *    "Category","Budgeted","Activity","Available"
 *
 * Everything is tolerant by design (FR-31): a malformed ROW becomes a
 * { line, reason } issue for the discrepancy report and parsing continues;
 * only a file that is structurally not the expected export (missing columns)
 * throws. Amounts are locale-formatted dollar strings ("C$1,234.56",
 * "-$138.93", "(45.00)") and are parsed string→integer — no value ever exists
 * as a binary float (ADR-004, FR-32). YNAB stores milliunits natively, so the
 * round-trip is lossless.
 */

export interface MigrationRowIssue {
  /** 1-based line in the source CSV, header included. */
  line: number;
  reason: string;
}

export interface RegisterRow {
  line: number;
  account: string;
  flag: string;
  date: string;
  payee: string;
  /** Empty strings when the row is uncategorized (tracking accounts, etc.). */
  categoryGroup: string;
  category: string;
  memo: string;
  /** Signed: Inflow − Outflow (outflows negative, ADR-004). */
  amountMilliunits: Milliunits;
  status: TransactionStatus;
}

export interface PlanRow {
  line: number;
  /** 'YYYY-MM'. */
  month: string;
  categoryGroup: string;
  category: string;
  budgetedMilliunits: Milliunits;
  activityMilliunits: Milliunits;
  availableMilliunits: Milliunits;
}

export interface ParsedRegister {
  rows: RegisterRow[];
  issues: MigrationRowIssue[];
}

export interface ParsedPlan {
  rows: PlanRow[];
  issues: MigrationRowIssue[];
}

// --- amounts -------------------------------------------------------------------

/**
 * "C$1,234.56" / "$45.00" / "1234.56" / "-C$5.00" / "C$-5.00" / "(45.00)" /
 * unicode minus → signed milliunits; null when not money. Currency markers and
 * thousands separators are stripped on the STRING; the digits go through the
 * one audited string→milliunits parser (ADR-004).
 */
export function parseYnabAmount(raw: string): Milliunits | null {
  let s = raw.trim().replace(/[−–]/g, '-'); // unicode minus/dash → '-'
  if (s === '') return null;

  let negative = false;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) {
    negative = true;
    s = paren[1]!.trim();
  }

  // Optional sign on either side of an optional currency marker.
  const match = /^(-)?\s*(?:CAD|CA\$|C\$|\$)?\s*(-)?([0-9][0-9,]*(?:\.[0-9]+)?)$/.exec(s);
  if (!match) return null;
  const [, signBefore, signAfter, digits] = match;
  if (signBefore && signAfter) return null;
  if (signBefore || signAfter) negative = !negative ? true : negative;

  try {
    const magnitude = parseDollarsToMilliunits(digits!.replace(/,/g, ''));
    return negative ? milliunits(-magnitude) : magnitude;
  } catch {
    return null; // sub-cent precision or stray garbage
  }
}

// --- dates & months --------------------------------------------------------------

/** ISO round-trip check shared by both date forms; null when not a real date. */
function checkIso(iso: string): string | null {
  const roundTrip = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(roundTrip.getTime()) || !roundTrip.toISOString().startsWith(iso)) return null;
  return iso;
}

/**
 * 'YYYY-MM-DD' (YNAB's ISO date-format setting) or 'x/y/YYYY'. Slashed dates
 * are M/D/YYYY unless the first number cannot be a month (>12), in which case
 * D/M/YYYY — deterministic, and the fixture/export should prefer ISO.
 */
export function parseYnabDate(raw: string): string | null {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return checkIso(s);
  const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (!slashed) return null;
  const [, a, b, year] = slashed;
  const first = Number(a);
  const [month, day] = first > 12 ? [b!, a!] : [a!, b!];
  return checkIso(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
}

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/** 'YYYY-MM' | 'YYYY-MM-DD' | 'Jun 2026' | 'December 2025' → 'YYYY-MM'. */
export function parseYnabMonth(raw: string): string | null {
  const s = raw.trim();
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return parseYnabMonth(s.slice(0, 7));
  const named = /^([A-Za-z]+)\s+(\d{4})$/.exec(s);
  if (!named) return null;
  const name = named[1]!.toLowerCase();
  // Full name or its unambiguous 3+-letter prefix ('Jun', 'June', 'Sept').
  const index = MONTH_NAMES.findIndex((m) => m === name || (name.length >= 3 && m.startsWith(name)));
  if (index === -1) return null;
  return `${named[2]}-${String(index + 1).padStart(2, '0')}`;
}

// --- shared column helpers --------------------------------------------------------

function field(table: CsvTable, fields: string[], name: string): string {
  const index = table.columns.get(name);
  return index === undefined ? '' : (fields[index] ?? '');
}

/**
 * Category group + category for a record: prefer the separate columns; fall
 * back to splitting the combined "Group: Category" column on its first ': '
 * (which is also why "Inflow: Ready to Assign" arrives as group "Inflow" +
 * category "Ready to Assign" — the mapper in migrate.ts knows both spellings).
 */
function categoryOf(
  table: CsvTable,
  fields: string[],
): { categoryGroup: string; category: string } {
  if (table.columns.has('category group') || table.columns.has('category')) {
    return {
      categoryGroup: field(table, fields, 'category group'),
      category: field(table, fields, 'category'),
    };
  }
  const combined = field(table, fields, 'category group/category');
  if (combined === '') return { categoryGroup: '', category: '' };
  const split = combined.indexOf(': ');
  if (split === -1) return { categoryGroup: '', category: combined };
  return { categoryGroup: combined.slice(0, split), category: combined.slice(split + 2) };
}

function hasCategoryColumns(table: CsvTable): boolean {
  return (
    table.columns.has('category group/category') ||
    (table.columns.has('category group') && table.columns.has('category'))
  );
}

// --- the register CSV --------------------------------------------------------------

const CLEARED_VALUES: Record<string, TransactionStatus> = {
  cleared: 'cleared',
  uncleared: 'uncleared',
  reconciled: 'reconciled',
};

export function parseRegisterCsv(content: string): ParsedRegister {
  const table = readCsvTable(content);
  if (
    !table ||
    !['account', 'date', 'payee', 'outflow', 'inflow', 'cleared'].every((c) =>
      table.columns.has(c),
    ) ||
    !hasCategoryColumns(table)
  ) {
    throw new MigrationError('invalid_register_csv', {
      reason: 'not a YNAB register export (missing Account/Date/Payee/Category/Outflow/Inflow/Cleared columns)',
    });
  }

  const rows: RegisterRow[] = [];
  const issues: MigrationRowIssue[] = [];

  for (const { line, fields } of table.records) {
    const date = parseYnabDate(field(table, fields, 'date'));
    if (date === null) {
      issues.push({ line, reason: `unparseable date: "${field(table, fields, 'date')}"` });
      continue;
    }

    // Outflow/Inflow: blank counts as zero (some locales blank the unused side).
    const parseSide = (name: string): Milliunits | null => {
      const raw = field(table, fields, name);
      return raw === '' ? milliunits(0) : parseYnabAmount(raw);
    };
    const outflow = parseSide('outflow');
    const inflow = parseSide('inflow');
    if (outflow === null || inflow === null) {
      issues.push({
        line,
        reason: `unparseable amount: outflow "${field(table, fields, 'outflow')}", inflow "${field(table, fields, 'inflow')}"`,
      });
      continue;
    }

    const clearedRaw = field(table, fields, 'cleared');
    const status = CLEARED_VALUES[clearedRaw.trim().toLowerCase()];
    if (status === undefined) {
      // Tolerant: the row imports (as uncleared) but the oddity is reported.
      issues.push({ line, reason: `unknown Cleared value "${clearedRaw}" — imported as uncleared` });
    }

    rows.push({
      line,
      account: field(table, fields, 'account'),
      flag: field(table, fields, 'flag'),
      date,
      payee: field(table, fields, 'payee'),
      ...categoryOf(table, fields),
      memo: field(table, fields, 'memo'),
      amountMilliunits: milliunits(inflow - outflow),
      status: status ?? 'uncleared',
    });
  }

  return { rows, issues };
}

// --- the plan (budget) CSV -----------------------------------------------------------

export function parsePlanCsv(content: string): ParsedPlan {
  const table = readCsvTable(content);
  if (
    !table ||
    !['month', 'budgeted', 'activity', 'available'].every((c) => table.columns.has(c)) ||
    !hasCategoryColumns(table)
  ) {
    throw new MigrationError('invalid_plan_csv', {
      reason: 'not a YNAB plan export (missing Month/Category/Budgeted/Activity/Available columns)',
    });
  }

  const rows: PlanRow[] = [];
  const issues: MigrationRowIssue[] = [];

  for (const { line, fields } of table.records) {
    const month = parseYnabMonth(field(table, fields, 'month'));
    if (month === null) {
      issues.push({ line, reason: `unparseable month: "${field(table, fields, 'month')}"` });
      continue;
    }
    const budgeted = parseYnabAmount(field(table, fields, 'budgeted'));
    const activity = parseYnabAmount(field(table, fields, 'activity'));
    const available = parseYnabAmount(field(table, fields, 'available'));
    if (budgeted === null || activity === null || available === null) {
      issues.push({ line, reason: 'unparseable Budgeted/Activity/Available amount' });
      continue;
    }
    rows.push({
      line,
      month,
      ...categoryOf(table, fields),
      budgetedMilliunits: budgeted,
      activityMilliunits: activity,
      availableMilliunits: available,
    });
  }

  return { rows, issues };
}
