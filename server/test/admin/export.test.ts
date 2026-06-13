import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { milliunits, parseDollarsToMilliunits } from '@ynab-clone/shared';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedSystemCategories, INFLOW_READY_TO_ASSIGN_CATEGORY_ID } from '../../src/db/seed.js';
import { accountBalances, closeAccount, createAccount, createTransaction } from '../../src/ledger/index.js';
import { setAssignedAmount } from '../../src/budget/index.js';
import { getBudgetMonth } from '../../src/budget/grid.js';
import {
  budgetCsvLines,
  csvField,
  registerCsvLines,
  BUDGET_CSV_HEADER,
  REGISTER_CSV_HEADER,
} from '../../src/admin/export.js';

/**
 * E7.S2 (FR-36): the register and budget CSV exports. The Verified-by is
 * executed literally below: re-totaling the register CSV per account
 * reproduces every account balance to the cent, and budget rows match the
 * engine's values exactly. Splits export as their LINES (the parent's total
 * merely duplicates them), so totals stay exact while category detail
 * survives — the YNAB-register convention.
 */

/** Minimal RFC-4180 parser (quoted fields, embedded commas/quotes/newlines). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function col(header: string[], name: string): number {
  const index = header.indexOf(name);
  if (index === -1) throw new Error(`no column ${name}`);
  return index;
}

describe('CSV export (E7.S2, FR-36)', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ynab-e7-export-'));
    db = openDatabase(join(dir, 'app.db'));
    runMigrations(db);
    seedSystemCategories(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seedData(): { chequingId: string; savingsId: string; closedId: string } {
    db.prepare("INSERT INTO category_groups (id, name, sort_order) VALUES ('g1', 'Everyday', 1)").run();
    db.prepare("INSERT INTO categories (id, group_id, name) VALUES ('groceries', 'g1', 'Groceries')").run();
    db.prepare("INSERT INTO categories (id, group_id, name) VALUES ('dining', 'g1', 'Dining')").run();
    // A hidden category — exports include EVERYTHING (FR-11).
    db.prepare("INSERT INTO categories (id, group_id, name, hidden) VALUES ('legacy', 'g1', 'Legacy', 1)").run();

    const chequing = createAccount(db, {
      name: 'Chequing',
      type: 'chequing',
      startingBalanceMilliunits: milliunits(500_000),
      startingDate: '2026-01-01',
    });
    const savings = createAccount(db, {
      name: 'Savings',
      type: 'savings',
      startingBalanceMilliunits: milliunits(0),
      startingDate: '2026-01-01',
    });
    const old = createAccount(db, {
      name: 'Old "Closed", account',
      type: 'chequing',
      startingBalanceMilliunits: milliunits(42_000),
      startingDate: '2026-01-01',
    });

    createTransaction(db, {
      accountId: chequing.id,
      date: '2026-01-15',
      amountMilliunits: milliunits(2_000_000),
      payeeName: 'Employer, Inc.', // comma — must survive quoting
      categoryId: INFLOW_READY_TO_ASSIGN_CATEGORY_ID,
      memo: 'pay "January"', // quotes
    });
    createTransaction(db, {
      accountId: chequing.id,
      date: '2026-01-20',
      amountMilliunits: milliunits(-150_930), // exact-cents rendering: -150.93
      payeeName: 'Loblaws',
      categoryId: 'groceries',
      memo: 'line1\nline2', // newline
    });
    createTransaction(db, {
      accountId: chequing.id,
      date: '2026-02-03',
      amountMilliunits: milliunits(-90_000),
      payeeName: 'Costco',
      categoryId: null,
      memo: 'split',
      splits: [
        { categoryId: 'groceries', amountMilliunits: milliunits(-60_000), memo: 'food' },
        { categoryId: 'dining', amountMilliunits: milliunits(-30_000), memo: 'court' },
      ],
    });
    createTransaction(db, {
      accountId: chequing.id,
      date: '2026-02-10',
      amountMilliunits: milliunits(-100_000),
      payeeName: null,
      categoryId: null,
      memo: 'to savings',
      transferAccountId: savings.id,
    });
    createTransaction(db, {
      accountId: old.id,
      date: '2026-01-30',
      amountMilliunits: milliunits(-10_000),
      payeeName: 'Legacy Shop',
      categoryId: 'legacy',
      memo: '',
    });
    closeAccount(db, old.id);

    setAssignedAmount(db, 'groceries', '2026-01', milliunits(100_000));
    setAssignedAmount(db, 'dining', '2026-02', milliunits(50_000));
    return { chequingId: chequing.id, savingsId: savings.id, closedId: old.id };
  }

  it('csvField quotes commas, quotes, and newlines per RFC 4180', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
  });

  it('AC-1: row count equals the register accounting lines (splits as lines, parents omitted)', () => {
    seedData();
    const rows = parseCsv([...registerCsvLines(db)].join(''));
    expect(rows[0]).toEqual(REGISTER_CSV_HEADER);
    // Money-bearing lines: every row except split parents.
    const expected = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM transactions t
           WHERE NOT EXISTS (SELECT 1 FROM transactions l WHERE l.parent_id = t.id)`,
        )
        .get() as { n: number }
    ).n;
    expect(rows.length - 1).toBe(expected);
    // …and the split exported as exactly its two lines, never its parent.
    const header = rows[0]!;
    const lines = rows.slice(1).filter((r) => r[col(header, 'ParentId')] !== '');
    expect(lines).toHaveLength(2);
    expect(lines.map((r) => r[col(header, 'Category')]).sort()).toEqual(['Dining', 'Groceries']);
    expect(lines.every((r) => r[col(header, 'Payee')] === 'Costco')).toBe(true);
  });

  it('AC-2 (FR-36 Verified-by): re-totaling per account reproduces every balance to the cent', () => {
    const { chequingId, savingsId, closedId } = seedData();
    const rows = parseCsv([...registerCsvLines(db)].join(''));
    const header = rows[0]!;
    const totals = new Map<string, number>();
    for (const row of rows.slice(1)) {
      const account = row[col(header, 'Account')]!;
      // Re-total EXTERNALLY: parse the dollar string back, integer math only.
      const amount = parseDollarsToMilliunits(row[col(header, 'Amount')]!);
      totals.set(account, (totals.get(account) ?? 0) + amount);
    }
    expect(totals.get('Chequing')).toBe(accountBalances(db, chequingId).workingMilliunits);
    expect(totals.get('Savings')).toBe(accountBalances(db, savingsId).workingMilliunits);
    // Closed accounts are included — export is everything (FR-11).
    expect(totals.get('Old "Closed", account')).toBe(
      accountBalances(db, closedId).workingMilliunits,
    );
  });

  it('AC-5: exact cent rendering, ISO dates, faithful status/approval/source/transfer columns', () => {
    seedData();
    const rows = parseCsv([...registerCsvLines(db)].join(''));
    const header = rows[0]!;
    const body = rows.slice(1);

    const loblaws = body.find((r) => r[col(header, 'Payee')] === 'Loblaws')!;
    expect(loblaws[col(header, 'Amount')]).toBe('-150.93'); // milliunits → exact cents
    expect(loblaws[col(header, 'Date')]).toBe('2026-01-20');
    expect(loblaws[col(header, 'Memo')]).toBe('line1\nline2'); // survived quoting
    expect(loblaws[col(header, 'Status')]).toBe('uncleared');
    expect(loblaws[col(header, 'Approved')]).toBe('yes');
    expect(loblaws[col(header, 'Source')]).toBe('manual');

    const employer = body.find((r) => r[col(header, 'Payee')] === 'Employer, Inc.')!;
    expect(employer[col(header, 'Memo')]).toBe('pay "January"');

    // The transfer: both sides present, peer account named, derived payee.
    const transferSides = body.filter((r) => r[col(header, 'TransferAccount')] !== '');
    expect(transferSides).toHaveLength(2);
    const out = transferSides.find((r) => r[col(header, 'Account')] === 'Chequing')!;
    expect(out[col(header, 'TransferAccount')]).toBe('Savings');
    expect(out[col(header, 'Payee')]).toBe('Transfer: Savings');
    expect(out[col(header, 'Amount')]).toBe('-100.00');
    const into = transferSides.find((r) => r[col(header, 'Account')] === 'Savings')!;
    expect(into[col(header, 'Amount')]).toBe('100.00');

    // Starting balances are real, exported rows (ADR-005 auditability).
    const starting = body.filter((r) => r[col(header, 'IsStartingBalance')] === 'yes');
    expect(starting).toHaveLength(3);
  });

  it('AC-3: budget export carries assigned/activity/available per category per month, matching the engine', () => {
    seedData();
    const rows = parseCsv([...budgetCsvLines(db, '2026-02')].join(''));
    const header = rows[0]!;
    expect(header).toEqual(BUDGET_CSV_HEADER);
    const body = rows.slice(1);

    const months = [...new Set(body.map((r) => r[col(header, 'Month')]))];
    expect(months).toEqual(['2026-01', '2026-02']); // every month with data

    for (const month of months) {
      const engine = getBudgetMonth(db, month!, '2026-02-15');
      const monthRows = body.filter((r) => r[col(header, 'Month')] === month);
      for (const group of engine.groups) {
        for (const category of group.categories) {
          const row = monthRows.find((r) => r[col(header, 'Category')] === category.name)!;
          expect(row, `${month} ${category.name}`).toBeDefined();
          expect(parseDollarsToMilliunits(row[col(header, 'Assigned')]!)).toBe(category.assignedMilliunits);
          expect(parseDollarsToMilliunits(row[col(header, 'Activity')]!)).toBe(category.activityMilliunits);
          expect(parseDollarsToMilliunits(row[col(header, 'Available')]!)).toBe(category.availableMilliunits);
          expect(parseDollarsToMilliunits(row[col(header, 'Carryover')]!)).toBe(category.carryoverMilliunits);
        }
      }
    }

    // Hidden categories are exported too (the grid hides them; export = everything).
    const legacy = body.find(
      (r) => r[col(header, 'Month')] === '2026-01' && r[col(header, 'Category')] === 'Legacy',
    )!;
    expect(legacy[col(header, 'Hidden')]).toBe('yes');
    expect(parseDollarsToMilliunits(legacy[col(header, 'Activity')]!)).toBe(-10_000);
  });

  it('budget export of an empty database is just the header', () => {
    expect([...budgetCsvLines(db, '2026-06')]).toHaveLength(1);
    expect([...registerCsvLines(db)]).toHaveLength(1);
  });
});
