import type Database from 'better-sqlite3';
import { milliunits } from '@ynab-clone/shared';
import type {
  ReviewItemResponse,
  ReviewMatchInfo,
  TransactionResponse,
} from '@ynab-clone/shared';
import {
  createTransaction,
  deleteTransaction,
  getAccountRow,
  getTransaction,
  LedgerError,
  setImportIdentity,
} from '../ledger/index.js';
import { ImportError } from './errors.js';
import type { ImportSource } from './pipeline.js';
import { suggestCategoryId } from './pipeline.js';

/**
 * Review queue + match trail (E4.S2/S3, FR-22/23). READS go straight at the
 * tables (same posture as the budget module); every WRITE goes through the
 * ledger command seam (ADR-001) — reject deletes via deleteTransaction,
 * unmatch reverts via setImportIdentity and recreates via createTransaction.
 */

interface MatchRow {
  id: string;
  transaction_id: string;
  import_batch_id: string | null;
  source: string;
  external_id: string | null;
  imported_date: string;
  imported_payee: string;
  imported_memo: string;
  imported_amount_milliunits: number;
  prior_status: 'uncleared' | 'cleared' | 'reconciled';
  prior_approved: number;
  prior_import_id: string | null;
  prior_import_batch_id: string | null;
}

/** Latest merge recorded on a row (a row carries at most one live match). */
function matchFor(db: Database.Database, transactionId: string): MatchRow | undefined {
  return db
    .prepare(
      `SELECT * FROM match_candidates WHERE transaction_id = ?
       ORDER BY matched_at DESC, rowid DESC LIMIT 1`,
    )
    .get(transactionId) as MatchRow | undefined;
}

function toMatchInfo(match: MatchRow): ReviewMatchInfo {
  return {
    matchId: match.id,
    importedDate: match.imported_date,
    importedPayee: match.imported_payee,
    importedAmountMilliunits: match.imported_amount_milliunits,
    externalId: match.external_id,
  };
}

/**
 * All unapproved transactions across accounts, newest first (S2 AC-1), each
 * annotated with its T2 match when it is a merge rather than a plain new row
 * (S3 AC-5) and with the payee's last-used category when the row itself is
 * still uncategorized (FR-19).
 */
export function listReviewQueue(db: Database.Database): ReviewItemResponse[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.payee_id, t.category_id, a.name AS account_name, a.on_budget
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       WHERE t.approved = 0 AND t.parent_id IS NULL
       ORDER BY t.date DESC, t.rowid DESC`,
    )
    .all() as {
    id: string;
    payee_id: string | null;
    category_id: string | null;
    account_name: string;
    on_budget: number;
  }[];

  const categoryName = db.prepare('SELECT name FROM categories WHERE id = ?');
  const lastUsed = db.prepare('SELECT last_category_id FROM payees WHERE id = ?');

  return rows.map((row): ReviewItemResponse => {
    const transaction = getTransaction(db, row.id);
    const match = matchFor(db, row.id);

    let suggestedCategoryId: string | null = null;
    if (row.category_id === null && row.on_budget === 1 && row.payee_id !== null) {
      const payee = lastUsed.get(row.payee_id) as { last_category_id: string | null } | undefined;
      suggestedCategoryId = payee?.last_category_id ?? null;
    }
    const suggestedName =
      suggestedCategoryId === null
        ? null
        : ((categoryName.get(suggestedCategoryId) as { name: string } | undefined)?.name ?? null);

    return {
      transaction,
      accountName: row.account_name,
      match: match === undefined ? null : toMatchInfo(match),
      suggestedCategoryId,
      suggestedCategoryName: suggestedName,
    };
  });
}

/** Which of these rows carry a merge — the register's Unmatch affordance (S3 AC-3). */
export function matchedTransactionIds(db: Database.Database, ids: string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT DISTINCT transaction_id FROM match_candidates
       WHERE transaction_id IN (${placeholders})`,
    )
    .all(...ids) as { transaction_id: string }[];
  return new Set(rows.map((r) => r.transaction_id));
}

export interface UnmatchResult {
  revertedTransaction: TransactionResponse;
  restoredTransaction: TransactionResponse;
}

/**
 * Undo a T2 merge (S3 AC-3): the register row reverts to its full pre-merge
 * state (status, approved flag, prior import identity) and the imported side
 * comes back as its own unapproved row — nothing is lost in either direction.
 */
export function unmatchTransaction(db: Database.Database, transactionId: string): UnmatchResult {
  const run = db.transaction((): UnmatchResult => {
    const match = matchFor(db, transactionId);
    if (match === undefined) throw new ImportError('match_not_found');

    const reverted = setImportIdentity(db, transactionId, {
      importId: match.prior_import_id,
      importBatchId: match.prior_import_batch_id,
      status: match.prior_status,
      approved: match.prior_approved === 1,
    });

    const account = getAccountRow(db, reverted.accountId);
    const restored = createTransaction(db, {
      accountId: account.id,
      date: match.imported_date,
      amountMilliunits: milliunits(match.imported_amount_milliunits),
      payeeName: match.imported_payee,
      categoryId: suggestCategoryId(db, account.onBudget, match.imported_payee),
      memo: match.imported_memo,
      status: 'cleared',
      approved: false,
      source: match.source as ImportSource,
      importId: match.external_id,
      importBatchId: match.import_batch_id,
    });

    db.prepare('DELETE FROM match_candidates WHERE id = ?').run(match.id);
    return { revertedTransaction: reverted, restoredTransaction: restored };
  });
  return run();
}

export interface RejectResult {
  rememberedExternalId: string | null;
  /** Accounts whose balances changed (for the one-round-trip client update). */
  accountIds: string[];
}

/**
 * Reject an unapproved transaction (S2 AC-4): it leaves the register, and its
 * external id is remembered per account so the same bank transaction in the
 * next overlapping import does not reappear. Rejecting a MERGED row first
 * unmatches it — the user's own pre-merge transaction survives; only the
 * imported copy is rejected.
 */
export function rejectTransaction(db: Database.Database, transactionId: string): RejectResult {
  const run = db.transaction((): RejectResult => {
    const row = db
      .prepare('SELECT id, approved, parent_id FROM transactions WHERE id = ?')
      .get(transactionId) as { id: string; approved: number; parent_id: string | null } | undefined;
    if (!row) throw new LedgerError('transaction_not_found');
    if (row.parent_id !== null) throw new LedgerError('split_line_not_addressable');
    if (row.approved === 1) throw new ImportError('transaction_already_approved');

    // A merge holds the user's own data — peel the import back off first.
    const match = matchFor(db, transactionId);
    const targetId =
      match === undefined ? transactionId : unmatchTransaction(db, transactionId).restoredTransaction.id;

    const target = db
      .prepare('SELECT account_id, import_id FROM transactions WHERE id = ?')
      .get(targetId) as { account_id: string; import_id: string | null };
    if (target.import_id !== null) {
      db.prepare(
        'INSERT OR IGNORE INTO rejected_externals (account_id, external_id) VALUES (?, ?)',
      ).run(target.account_id, target.import_id);
    }
    const { accountIds } = deleteTransaction(db, targetId);
    return { rememberedExternalId: target.import_id, accountIds };
  });
  return run();
}
