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
  createAccount,
  createTransaction,
  getOrCreatePayee,
  searchPayees,
  updateTransaction,
} from '../../src/ledger/index.js';

// E2.S3 payee domain logic (FR-19): canonical names, substring autocomplete,
// last-category memory.

describe('ledger payees (E2.S3, FR-19)', () => {
  let db: Database.Database;
  let accountId: string;
  let groceriesId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db);
    seedSystemCategories(db);
    accountId = createAccount(db, {
      name: 'Chequing',
      type: 'chequing',
      startingBalanceMilliunits: milliunits(0),
      startingDate: '2026-01-01',
    }).id;
    groceriesId = 'cat-groceries';
    db.prepare("INSERT INTO category_groups (id, name) VALUES ('g1', 'Everyday')").run();
    db.prepare("INSERT INTO categories (id, group_id, name) VALUES (?, 'g1', 'Groceries')").run(
      groceriesId,
    );
  });
  afterEach(() => {
    db.close();
  });

  it('canonicalizes payee names: first spelling wins, later case variants resolve to the same row', () => {
    const first = getOrCreatePayee(db, 'Loblaws');
    const again = getOrCreatePayee(db, '  loblaws  ');
    expect(again!.id).toBe(first!.id);
    expect(again!.name).toBe('Loblaws');
    expect(getOrCreatePayee(db, '   ')).toBeNull();
  });

  it('AC-4: a payee typed once is offered for any later matching substring', () => {
    createTransaction(db, {
      accountId,
      date: '2026-02-01',
      amountMilliunits: milliunits(-10000),
      payeeName: 'Shoppers Drug Mart',
    });
    const matches = searchPayees(db, 'drug');
    expect(matches.map((p) => p.name)).toEqual(['Shoppers Drug Mart']);
    expect(searchPayees(db, 'zzz')).toEqual([]);
  });

  it('AC-5: the last category used with a payee is remembered as the default suggestion', () => {
    createTransaction(db, {
      accountId,
      date: '2026-02-01',
      amountMilliunits: milliunits(-45200),
      payeeName: 'Loblaws',
      categoryId: groceriesId,
    });
    const [loblaws] = searchPayees(db, 'Loblaws');
    expect(loblaws!.lastCategoryId).toBe(groceriesId);
    expect(loblaws!.lastCategoryName).toBe('Groceries');

    // Recategorizing updates the memory to the most recent choice.
    const tx = createTransaction(db, {
      accountId,
      date: '2026-02-02',
      amountMilliunits: milliunits(2000000),
      payeeName: 'Loblaws',
      categoryId: groceriesId,
    });
    updateTransaction(db, tx.id, { categoryId: INFLOW_READY_TO_ASSIGN_CATEGORY_ID });
    expect(searchPayees(db, 'Loblaws')[0]!.lastCategoryId).toBe(
      INFLOW_READY_TO_ASSIGN_CATEGORY_ID,
    );
  });

  it('an uncategorized transaction does not clobber the remembered category', () => {
    createTransaction(db, {
      accountId,
      date: '2026-02-01',
      amountMilliunits: milliunits(-100),
      payeeName: 'Loblaws',
      categoryId: groceriesId,
    });
    createTransaction(db, {
      accountId,
      date: '2026-02-02',
      amountMilliunits: milliunits(-100),
      payeeName: 'Loblaws',
    });
    expect(searchPayees(db, 'Loblaws')[0]!.lastCategoryId).toBe(groceriesId);
  });
});
