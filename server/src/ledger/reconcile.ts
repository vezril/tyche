import type Database from 'better-sqlite3';
import { milliunits, type Milliunits } from '@ynab-clone/shared';
import { RECONCILIATION_ADJUSTMENT_CATEGORY_ID } from '../db/seed.js';
import { accountBalances, getAccountRow } from './accounts.js';
import { assertValidIsoDate } from './errors.js';
import { createTransaction } from './transactions.js';

/**
 * Reconciliation (E2.S7, FR-18) — the trust ritual: compare the bank's actual
 * balance to the cleared balance, absorb any residual difference into a
 * cleared balance-adjustment transaction (categorized to the *Reconciliation
 * adjustment* system category seeded at first run by E1.S1 — never created
 * here), then lock every cleared row as reconciled. One SQLite transaction:
 * either the whole ritual lands or none of it.
 *
 * Post-condition (FR-18 verified-by): cleared balance === entered bank
 * balance, because the adjustment makes the difference exactly $0 and the
 * cleared→reconciled sweep keeps every row inside the cleared SUM.
 *
 * No "reconciliation report" entity exists — the locked statuses plus the
 * adjustment row ARE the record (S7 dev notes).
 */

export const RECONCILIATION_ADJUSTMENT_PAYEE = 'Reconciliation Balance Adjustment';

export interface ReconcileInput {
  /** The bank's actual balance as the user entered it. */
  bankBalanceMilliunits: Milliunits;
  /** Date for the adjustment row; defaults to today. */
  date?: string;
}

export interface ReconcileResult {
  /** Set when a nonzero difference produced an adjustment row. */
  adjustmentTransactionId: string | null;
  /** Parents only — mirrored split lines are not counted twice. */
  reconciledCount: number;
}

export function reconcileAccount(
  db: Database.Database,
  accountId: string,
  input: ReconcileInput,
): ReconcileResult {
  const run = db.transaction((): ReconcileResult => {
    const account = getAccountRow(db, accountId);
    const date = input.date ?? new Date().toISOString().slice(0, 10);
    assertValidIsoDate(date);

    const { clearedMilliunits } = accountBalances(db, accountId);
    const difference = milliunits(input.bankBalanceMilliunits - clearedMilliunits);

    let adjustmentTransactionId: string | null = null;
    if (difference !== 0) {
      // Cleared so the sweep below locks it too; categorized to the system
      // category on on-budget accounts (it is real spending/income for the
      // budget); tracking rows never carry a category (FR-10).
      adjustmentTransactionId = createTransaction(db, {
        accountId,
        date,
        amountMilliunits: difference,
        payeeName: RECONCILIATION_ADJUSTMENT_PAYEE,
        categoryId: account.onBudget ? RECONCILIATION_ADJUSTMENT_CATEGORY_ID : null,
        memo: 'Reconciliation balance adjustment',
        status: 'cleared',
      }).id;
    }

    const counted = db
      .prepare(
        `SELECT COUNT(*) AS n FROM transactions
         WHERE account_id = ? AND status = 'cleared' AND parent_id IS NULL`,
      )
      .get(accountId) as { n: number };
    // The sweep includes split children (they mirror the parent's status).
    db.prepare(
      `UPDATE transactions SET status = 'reconciled'
       WHERE account_id = ? AND status = 'cleared'`,
    ).run(accountId);

    return { adjustmentTransactionId, reconciledCount: counted.n };
  });
  return run();
}
