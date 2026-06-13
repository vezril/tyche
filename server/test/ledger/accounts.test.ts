import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { milliunits } from '@ynab-clone/shared';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  INFLOW_READY_TO_ASSIGN_CATEGORY_ID,
  seedSystemCategories,
} from '../../src/db/seed.js';
import {
  accountBalances,
  closeAccount,
  createAccount,
  createTransaction,
  LedgerError,
  listAccounts,
  reopenAccount,
} from '../../src/ledger/index.js';

// E2.S1 domain logic: accounts with derived balances (ADR-005) and the
// starting balance modeled as a real, auditable transaction (NFR-12).

describe('ledger accounts (E2.S1)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db);
    seedSystemCategories(db);
  });
  afterEach(() => {
    db.close();
  });

  it('creates an on-budget account whose starting balance is a real cleared transaction categorized to Inflow: Ready to Assign (AC-1, NFR-12)', () => {
    const account = createAccount(db, {
      name: 'Chequing',
      type: 'chequing',
      startingBalanceMilliunits: milliunits(1234560),
      startingDate: '2026-06-01',
    });
    expect(account.onBudget).toBe(true);

    const row = db
      .prepare('SELECT * FROM transactions WHERE account_id = ?')
      .get(account.id) as Record<string, unknown>;
    expect(row['amount_milliunits']).toBe(1234560);
    expect(row['category_id']).toBe(INFLOW_READY_TO_ASSIGN_CATEGORY_ID);
    expect(row['status']).toBe('cleared');
    expect(row['is_starting_balance']).toBe(1);
    expect(row['date']).toBe('2026-06-01');

    const balances = accountBalances(db, account.id);
    expect(balances.workingMilliunits).toBe(1234560);
    expect(balances.clearedMilliunits).toBe(1234560);
  });

  it('creates a tracking account off-budget with an UNCATEGORIZED starting balance (AC-3, FR-10)', () => {
    const account = createAccount(db, {
      name: 'TFSA',
      type: 'tracking',
      startingBalanceMilliunits: milliunits(50000000),
      startingDate: '2026-06-01',
    });
    expect(account.onBudget).toBe(false);

    const row = db
      .prepare('SELECT category_id FROM transactions WHERE account_id = ?')
      .get(account.id) as { category_id: string | null };
    expect(row.category_id).toBeNull();
  });

  it('derives working balance = starting balance + sum of transactions; cleared counts only cleared/reconciled (AC-2, AC-5)', () => {
    const account = createAccount(db, {
      name: 'Spending',
      type: 'chequing',
      startingBalanceMilliunits: milliunits(100000), // $100, cleared
      startingDate: '2026-06-01',
    });
    createTransaction(db, {
      accountId: account.id,
      date: '2026-06-02',
      amountMilliunits: milliunits(-25500), // uncleared outflow
    });
    createTransaction(db, {
      accountId: account.id,
      date: '2026-06-03',
      amountMilliunits: milliunits(40000),
      status: 'cleared',
    });

    const balances = accountBalances(db, account.id);
    expect(balances.workingMilliunits).toBe(100000 - 25500 + 40000);
    expect(balances.clearedMilliunits).toBe(100000 + 40000);
  });

  it('recreates the five real account shapes with balances = starting + transactions (AC-2, FR-12)', () => {
    const shapes = [
      { name: 'RBC Chequing', type: 'chequing', start: 2500000 },
      { name: 'Tangerine Chequing', type: 'savings', start: 1000000 },
      { name: 'Joint Chequing', type: 'chequing', start: 750000 },
      { name: 'Savings', type: 'savings', start: 12000000 },
      { name: 'TFSA', type: 'tracking', start: 50000000 },
    ] as const;
    for (const s of shapes) {
      const a = createAccount(db, {
        name: s.name,
        type: s.type,
        startingBalanceMilliunits: milliunits(s.start),
        startingDate: '2026-01-01',
      });
      createTransaction(db, {
        accountId: a.id,
        date: '2026-02-01',
        amountMilliunits: milliunits(-10010),
      });
    }
    const accounts = listAccounts(db, { includeClosed: false });
    expect(accounts).toHaveLength(5);
    for (const account of accounts) {
      const shape = shapes.find((s) => s.name === account.name)!;
      expect(account.workingBalanceMilliunits).toBe(shape.start - 10010);
    }
  });

  it('rejects a duplicate account name', () => {
    createAccount(db, {
      name: 'Chequing',
      type: 'chequing',
      startingBalanceMilliunits: milliunits(0),
      startingDate: '2026-06-01',
    });
    expect(() =>
      createAccount(db, {
        name: 'chequing', // case-insensitive duplicate
        type: 'savings',
        startingBalanceMilliunits: milliunits(0),
        startingDate: '2026-06-01',
      }),
    ).toThrowError(LedgerError);
  });

  it('close hides the account from active lists but keeps history; reopen restores it (AC-4, FR-11)', () => {
    const account = createAccount(db, {
      name: 'Old Chequing',
      type: 'chequing',
      startingBalanceMilliunits: milliunits(5000),
      startingDate: '2026-06-01',
    });
    closeAccount(db, account.id);

    expect(listAccounts(db, { includeClosed: false })).toHaveLength(0);
    const all = listAccounts(db, { includeClosed: true });
    expect(all).toHaveLength(1);
    expect(all[0]!.closed).toBe(true);
    // History preserved: the starting-balance transaction is still there.
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?').get(account.id),
    ).toEqual({ n: 1 });

    reopenAccount(db, account.id);
    expect(listAccounts(db, { includeClosed: false })).toHaveLength(1);
  });
});
