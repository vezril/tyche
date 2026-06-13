import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { milliunits } from '@ynab-clone/shared';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedSystemCategories } from '../../src/db/seed.js';
import {
  accountBalances,
  createAccount,
  createTransaction,
  deleteTransaction,
  reconcileAccount,
  updateTransaction,
} from '../../src/ledger/index.js';

// E2.S5/S7 balance math units (ADR-005): every figure below is a SUM over raw
// rows — these tests assert the invariants the API layer relies on.

describe('ledger balance math: transfers + reconciliation (E2.S5, E2.S7)', () => {
  let db: Database.Database;
  let spendingId: string;
  let savingsId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db);
    seedSystemCategories(db);
    spendingId = createAccount(db, {
      name: 'Spending',
      type: 'chequing',
      startingBalanceMilliunits: milliunits(1000000),
      startingDate: '2026-01-01',
    }).id;
    savingsId = createAccount(db, {
      name: 'Savings',
      type: 'savings',
      startingBalanceMilliunits: milliunits(5000000),
      startingDate: '2026-01-01',
    }).id;
  });
  afterEach(() => {
    db.close();
  });

  it('a transfer is zero-sum across accounts: the two rows always negate each other', () => {
    const t = createTransaction(db, {
      accountId: spendingId,
      date: '2026-06-10',
      amountMilliunits: milliunits(-200000),
      transferAccountId: savingsId,
    });
    expect(accountBalances(db, spendingId).workingMilliunits).toBe(800000);
    expect(accountBalances(db, savingsId).workingMilliunits).toBe(5200000);

    // editing either side preserves the zero-sum invariant via the cascade
    updateTransaction(db, t.id, { amountMilliunits: milliunits(-275000) });
    expect(accountBalances(db, spendingId).workingMilliunits).toBe(725000);
    expect(accountBalances(db, savingsId).workingMilliunits).toBe(5275000);
    const total = db
      .prepare('SELECT SUM(amount_milliunits) AS s FROM transactions WHERE transfer_id IS NOT NULL')
      .get() as { s: number };
    expect(total.s).toBe(0);

    // deleting one side removes both — balances return to pre-transfer values
    const { accountIds } = deleteTransaction(db, t.id);
    expect(accountIds.sort()).toEqual([spendingId, savingsId].sort());
    expect(accountBalances(db, spendingId).workingMilliunits).toBe(1000000);
    expect(accountBalances(db, savingsId).workingMilliunits).toBe(5000000);
  });

  it('reconcile: cleared balance equals the entered bank balance, exactly, in integers (FR-18)', () => {
    createTransaction(db, {
      accountId: spendingId,
      date: '2026-06-01',
      amountMilliunits: milliunits(-123456),
      payeeName: 'Odd Amount',
      status: 'cleared',
    });
    // cleared = 1000000 - 123456 = 876544; bank says 876540 → diff -4 milliunits?
    // No: user input is whole cents — bank balance 876.54 → 876540. diff = -4.
    const result = reconcileAccount(db, spendingId, {
      bankBalanceMilliunits: milliunits(876540),
      date: '2026-06-12',
    });
    expect(result.adjustmentTransactionId).not.toBeNull();
    const balances = accountBalances(db, spendingId);
    expect(balances.clearedMilliunits).toBe(876540); // EXACT integer equality, no epsilon
    expect(balances.workingMilliunits).toBe(876540);

    // the whole flow was atomic: adjustment + sweep landed together
    const leftoverCleared = db
      .prepare(
        "SELECT COUNT(*) AS n FROM transactions WHERE status = 'cleared' AND account_id = ?",
      )
      .get(spendingId) as { n: number };
    expect(leftoverCleared.n).toBe(0);
  });

  it('reconcile sweeps only the target account; transfer peers elsewhere stay untouched (S5 AC-5)', () => {
    createTransaction(db, {
      accountId: spendingId,
      date: '2026-06-10',
      amountMilliunits: milliunits(-200000),
      transferAccountId: savingsId,
      status: 'cleared', // both sides start cleared here
    });
    reconcileAccount(db, spendingId, { bankBalanceMilliunits: milliunits(800000) });

    const statuses = db
      .prepare(
        `SELECT a.id AS account_id, t.status FROM transactions t
         JOIN accounts a ON a.id = t.account_id WHERE t.transfer_id IS NOT NULL`,
      )
      .all() as { account_id: string; status: string }[];
    expect(statuses.find((s) => s.account_id === spendingId)?.status).toBe('reconciled');
    expect(statuses.find((s) => s.account_id === savingsId)?.status).toBe('cleared');
  });

  it('editing a transfer whose PEER is reconciled needs force too (the cascade would touch a locked row)', () => {
    const t = createTransaction(db, {
      accountId: spendingId,
      date: '2026-06-10',
      amountMilliunits: milliunits(-200000),
      transferAccountId: savingsId,
      status: 'cleared',
    });
    reconcileAccount(db, savingsId, { bankBalanceMilliunits: milliunits(5200000) });

    // this side is NOT reconciled, but the amount cascade hits the locked peer
    expect(() => updateTransaction(db, t.id, { amountMilliunits: milliunits(-100000) })).toThrowError(
      expect.objectContaining({ code: 'reconciled_transaction_locked' }) as Error,
    );
    // status-only changes stay per-side and need no force (S5 AC-5)
    expect(updateTransaction(db, t.id, { status: 'uncleared' }).status).toBe('uncleared');
    // with force, the cascade may proceed (S7 AC-4: explicit confirmation)
    const forced = updateTransaction(
      db,
      t.id,
      { amountMilliunits: milliunits(-100000) },
      { force: true },
    );
    expect(forced.amountMilliunits).toBe(-100000);
    expect(accountBalances(db, savingsId).workingMilliunits).toBe(5100000);
  });
});
