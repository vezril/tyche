import type Database from 'better-sqlite3';
import { parseDollarsToMilliunits, milliunits, type Milliunits } from '@ynab-clone/shared';
import { deleteTransaction, setImportIdentity, updateTransaction } from '../../ledger/index.js';
import { ImportError } from '../errors.js';
import { runImport } from '../pipeline.js';
import type { ImportRowIssue, StagedTransaction } from '../port.js';
import {
  PLAID_ITEM_LOGIN_REQUIRED,
  PLAID_MUTATION_ERROR,
  PlaidApiError,
  type PlaidClientPort,
  type PlaidRemovedTransaction,
  type PlaidSyncPage,
  type PlaidTransactionData,
} from './client.js';
import {
  appendSyncLog,
  getAccessToken,
  getPlaidItem,
  listAccountLinks,
  markNeedsRelink,
} from './items.js';

/**
 * The Plaid backend of the importer port (E5.S2, FR-21, ADR-006): page
 * /transactions/sync from the Item's stored cursor and feed `added`/`modified`
 * through the SHARED pipeline (`runImport(source:'plaid')`) — matching, review
 * and budget effects are therefore identical to file import by construction
 * (AC-6, FR-25). `removed` is handled here because it is not a staged row:
 * unapproved copies are voided, approved copies are flagged for review, and
 * the external id is remembered in rejected_externals either way (AC-3).
 *
 * Cursor discipline (AC-5): each page is applied inside ONE SQLite
 * transaction that also advances plaid_items.cursor — a crash or upstream
 * failure mid-stream leaves the cursor on the last fully applied page, and
 * re-running resumes from there without loss (the pipeline's T1 dedup makes
 * redelivery a no-op). On Plaid's TRANSACTIONS_SYNC_MUTATION error the loop
 * restarts from that same stored cursor, per the Plaid docs.
 */

/** Memo marker for approved rows the bank deleted upstream (AC-3, FR-22). */
export const REMOVED_BY_BANK_NOTE = 'Removed by bank';

const MAX_MUTATION_RESTARTS = 3;

export interface PlaidSyncResult {
  itemId: string;
  /** New register rows (pipeline T3). */
  addedCount: number;
  /** Rows merged into existing register rows (pipeline T2). */
  mergedCount: number;
  /** Rows updated in place from `modified` (pipeline T1-update). */
  updatedCount: number;
  /** `removed` for unapproved rows → row voided (deleted). */
  removedVoidedCount: number;
  /** `removed` for approved rows → flagged for review, not deleted. */
  removedFlaggedCount: number;
  /** Redeliveries / already-imported rows skipped by T1/T1b. */
  duplicateCount: number;
  /** Transactions ignored because their bank account is unmapped/skipped (AC-4). */
  ignoredUnmappedCount: number;
  /** Rows whose amount/shape could not be parsed (recorded on the batch too). */
  errors: ImportRowIssue[];
  /** App accounts whose balances may have changed. */
  accountIds: string[];
}

/**
 * Plaid decimal-string amount → ledger milliunits. Plaid's sign convention is
 * inverted (positive = outflow); the parse itself is the audited string-based
 * shared parser — the amount never exists as a binary float here (ADR-004).
 */
export function plaidAmountToMilliunits(amount: string): Milliunits {
  return milliunits(-parseDollarsToMilliunits(amount));
}

function stage(txn: PlaidTransactionData): StagedTransaction {
  return {
    date: txn.date,
    payee: txn.name,
    amountMilliunits: plaidAmountToMilliunits(txn.amount),
    externalId: txn.transactionId,
    memo: '',
    accountHint: txn.plaidAccountId,
    raw: txn.raw,
  };
}

interface RemovalCounts {
  voided: number;
  flagged: number;
}

/**
 * Apply one `removed` entry (AC-3): remember the external id per account so
 * it never resurrects (rejected_externals, same memory as a user reject),
 * then void an unapproved copy or flag an approved one for review. Approved
 * rows get a memo note + drop to unapproved instead of silent deletion; the
 * note also makes redelivery of the same removal idempotent.
 */
function applyRemoved(
  db: Database.Database,
  accountByPlaidId: Map<string, string>,
  removed: PlaidRemovedTransaction,
  counts: RemovalCounts,
  touchedAccounts: Set<string>,
): void {
  const hinted = removed.plaidAccountId === null ? null : accountByPlaidId.get(removed.plaidAccountId);
  const candidateAccounts = hinted !== undefined && hinted !== null ? [hinted] : [...accountByPlaidId.values()];
  if (candidateAccounts.length === 0) return; // nothing mapped — nothing to do (AC-4)

  const placeholders = candidateAccounts.map(() => '?').join(', ');
  const row = db
    .prepare(
      `SELECT id, account_id, approved, memo FROM transactions
       WHERE import_id = ? AND parent_id IS NULL AND account_id IN (${placeholders})`,
    )
    .get(removed.transactionId, ...candidateAccounts) as
    | { id: string; account_id: string; approved: number; memo: string }
    | undefined;

  const remember = db.prepare(
    'INSERT OR IGNORE INTO rejected_externals (account_id, external_id) VALUES (?, ?)',
  );
  if (row === undefined) {
    // Never seen (or already voided on a previous pass): just make sure the
    // id can never resurrect through any backend.
    for (const accountId of candidateAccounts) remember.run(accountId, removed.transactionId);
    return;
  }
  remember.run(row.account_id, removed.transactionId);
  touchedAccounts.add(row.account_id);

  if (row.approved === 0 && row.memo.includes(REMOVED_BY_BANK_NOTE)) {
    return; // already flagged on a previous pass — replay is a no-op
  }
  if (row.approved === 0) {
    // Unreviewed import — the bank withdrew it before Calvin ever saw it.
    deleteTransaction(db, row.id, { force: true });
    counts.voided += 1;
    return;
  }
  // Approved (Calvin vouched for it): never silently delete (AC-3). Flag it
  // back into the review queue with a visible note; he resolves it there.
  updateTransaction(
    db,
    row.id,
    { memo: row.memo === '' ? REMOVED_BY_BANK_NOTE : `${row.memo} · ${REMOVED_BY_BANK_NOTE}` },
    { force: true },
  );
  setImportIdentity(db, row.id, {
    importId: removed.transactionId,
    importBatchId: null,
    approved: false,
  });
  counts.flagged += 1;
}

function emptyResult(itemId: string): PlaidSyncResult {
  return {
    itemId,
    addedCount: 0,
    mergedCount: 0,
    updatedCount: 0,
    removedVoidedCount: 0,
    removedFlaggedCount: 0,
    duplicateCount: 0,
    ignoredUnmappedCount: 0,
    errors: [],
    accountIds: [],
  };
}

/**
 * One sync run for one Item — the same code path for manual "sync now" (this
 * story) and the S3 scheduler. Appends to the sync-health log on BOTH
 * outcomes (AC-7) and rethrows failures for the caller's error mapping.
 */
export async function syncPlaidItem(
  db: Database.Database,
  masterKey: Buffer,
  client: PlaidClientPort,
  itemId: string,
): Promise<PlaidSyncResult> {
  const item = getPlaidItem(db, itemId);
  if (item.status !== 'ACTIVE') throw new ImportError('plaid_item_not_active');

  const accountByPlaidId = new Map<string, string>();
  for (const link of listAccountLinks(db, itemId)) {
    if (link.accountId !== null && !link.skipped) {
      accountByPlaidId.set(link.plaidAccountId, link.accountId);
    }
  }

  // The ADR-007 consequence, handled gracefully (E7.S1 AC-3): after a restore
  // without the original MASTER_KEY, the stored token ciphertext is
  // unreadable. That is a re-link condition, not a crash loop — log it, flip
  // the Item to NEEDS_RELINK (re-linking writes a fresh token under the
  // current key), and report a clean error.
  let accessToken: string;
  try {
    accessToken = getAccessToken(db, masterKey, itemId);
  } catch (err) {
    appendSyncLog(db, itemId, {
      outcome: 'error',
      errorCode: 'TOKEN_DECRYPTION_FAILED',
      message: `stored access token is unreadable with the current MASTER_KEY (restore without the original key? see README) — re-link required: ${err instanceof Error ? err.message : String(err)}`,
    });
    markNeedsRelink(db, itemId);
    throw new ImportError('plaid_token_unreadable');
  }
  const result = emptyResult(itemId);
  const touchedAccounts = new Set<string>();
  let restarts = 0;

  try {
    let cursor = item.cursor;
    let hasMore = true;
    while (hasMore) {
      let page: PlaidSyncPage;
      try {
        page = await client.transactionsSync(accessToken, cursor);
      } catch (err) {
        if (
          err instanceof PlaidApiError &&
          err.plaidCode === PLAID_MUTATION_ERROR &&
          restarts < MAX_MUTATION_RESTARTS
        ) {
          // Upstream data mutated mid-pagination: restart from the last
          // APPLIED cursor (Plaid docs). Already-applied rows redeliver as
          // T1 dedup no-ops.
          restarts += 1;
          cursor = getPlaidItem(db, itemId).cursor;
          continue;
        }
        throw err;
      }

      // Apply the WHOLE page + cursor advance in one transaction (AC-5).
      const applyPage = db.transaction((): void => {
        // added + modified group by mapped app account; one shared-pipeline
        // run per account, with `modified` semantics via applyUpdates (AC-2).
        const byAccount = new Map<string, { staged: StagedTransaction[]; errors: ImportRowIssue[] }>();
        let line = 0;
        for (const txn of [...page.added, ...page.modified]) {
          line += 1;
          const accountId = accountByPlaidId.get(txn.plaidAccountId);
          if (accountId === undefined) {
            result.ignoredUnmappedCount += 1; // unmapped/skipped bank account (AC-4)
            continue;
          }
          let bucket = byAccount.get(accountId);
          if (bucket === undefined) {
            bucket = { staged: [], errors: [] };
            byAccount.set(accountId, bucket);
          }
          try {
            bucket.staged.push(stage(txn));
          } catch {
            bucket.errors.push({
              line,
              reason: `unparseable Plaid amount "${txn.amount}" (${txn.transactionId})`,
            });
          }
        }
        for (const [accountId, bucket] of byAccount) {
          const summary = runImport(db, {
            accountId,
            source: 'plaid',
            staged: bucket.staged,
            parseErrors: bucket.errors,
            applyUpdates: true,
          });
          result.addedCount += summary.createdIds.length;
          result.mergedCount += summary.mergedIds.length;
          result.updatedCount += summary.updatedIds.length;
          result.duplicateCount += summary.duplicateCount + summary.rejectedCount;
          result.errors.push(...bucket.errors);
          touchedAccounts.add(accountId);
        }

        const removalCounts: RemovalCounts = { voided: 0, flagged: 0 };
        for (const removed of page.removed) {
          applyRemoved(db, accountByPlaidId, removed, removalCounts, touchedAccounts);
        }
        result.removedVoidedCount += removalCounts.voided;
        result.removedFlaggedCount += removalCounts.flagged;

        // The cursor moves ONLY here, with the page it covers (AC-5).
        db.prepare(
          `UPDATE plaid_items SET cursor = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ?`,
        ).run(page.nextCursor, itemId);
      });
      applyPage();

      cursor = page.nextCursor;
      hasMore = page.hasMore;
    }

    result.accountIds = [...touchedAccounts];
    appendSyncLog(db, itemId, {
      outcome: 'success',
      addedCount: result.addedCount + result.mergedCount,
      updatedCount: result.updatedCount,
      removedCount: result.removedVoidedCount + result.removedFlaggedCount,
    });
    return result;
  } catch (err) {
    // Every attempt is logged, failures included (AC-7).
    appendSyncLog(db, itemId, {
      outcome: 'error',
      addedCount: result.addedCount + result.mergedCount,
      updatedCount: result.updatedCount,
      removedCount: result.removedVoidedCount + result.removedFlaggedCount,
      errorCode: err instanceof PlaidApiError ? err.plaidCode : null,
      message: err instanceof Error ? err.message : String(err),
    });
    // E5.S4 AC-1 (FR-26): re-auth required flips the Item to NEEDS_RELINK —
    // scheduled polling skips it from now on; recovery is Link update mode.
    // Any OTHER failure stays in the health log without changing state (AC-4).
    if (err instanceof PlaidApiError && err.plaidCode === PLAID_ITEM_LOGIN_REQUIRED) {
      markNeedsRelink(db, itemId);
    }
    throw err;
  }
}
