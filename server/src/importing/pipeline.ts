import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { milliunits } from '@tyche/shared';
import {
  createTransaction,
  getAccountRow,
  setImportIdentity,
  updateTransaction,
} from '../ledger/index.js';
import type { ImportRowIssue, StagedTransaction } from './port.js';

/**
 * The shared import pipeline (ADR-006, architecture §6): staged rows from ANY
 * backend → dedup/match (FR-23) → review queue (FR-22) → ledger, writing only
 * through the same ledger commands the UI uses (FR-25 — budget math never
 * sees `source`).
 *
 * Matching tiers, per ADR-006 / E4.S3:
 *
 *  T1  exact external id (OFX FITID, Plaid transaction_id) already in the
 *      account → idempotent skip (E5 extends this branch to "apply as update"
 *      for Plaid `modified` entries). A previously REJECTED external id is
 *      also honoured here: it never reappears (S2 AC-4).
 *
 *  T1b content identity, for sources with no external id (RBC CSV): a row
 *      with the same account/date/amount that is already import-borne — or a
 *      recorded merge whose IMPORTED side had this date/amount — is the same
 *      bank transaction arriving again → skip. This is what makes re-running
 *      the exact same CSV a no-op (S3 AC-1) without inventing fake ids.
 *
 *  T2  heuristic merge: same account + exact amount + date within ±5 days
 *      against rows with NO existing import identity (S3 AC-4) → merge into
 *      the existing row, preserving the user's category/memo, attaching the
 *      import identity + cleared status, and dropping to unapproved so the
 *      merge surfaces in the daily review (S3 AC-5). The full pre-merge state
 *      is recorded in match_candidates so unmatch can undo it (S3 AC-3).
 *
 *  T3  no match → new unapproved+cleared row with the payee canonicalized and
 *      the payee's last-used category pre-suggested (S1 AC-4, FR-19).
 *
 * Rows created or consumed during THIS run are never match targets for later
 * rows of the same run — two real $5.00 coffees in one file must not merge
 * into each other.
 */

export type ImportSource = 'file' | 'plaid' | 'migration';

export interface RunImportInput {
  accountId: string;
  source: ImportSource;
  /** Provenance for the ImportBatch record (S1 AC-3). */
  filename?: string | null;
  format?: 'ofx' | 'csv' | null;
  staged: StagedTransaction[];
  /** Per-row parse failures from the backend, recorded with the batch. */
  parseErrors?: ImportRowIssue[];
  /**
   * E5 (Plaid `modified`, S2 AC-2): when true, a staged row whose external id
   * is already in the account is applied as an UPDATE to that row — bank-owned
   * fields only (date, amount, cleared status); the user's category/memo/payee
   * survive untouched, and a content change drops the row to unapproved so it
   * resurfaces in review (FR-22). Content-identical redelivery stays an
   * idempotent skip. Default false = the E4 file behavior (skip).
   */
  applyUpdates?: boolean;
}

export interface ImportSummary {
  batchId: string;
  /** T3: new unapproved rows. */
  createdIds: string[];
  /** T2: register rows the import merged into. */
  mergedIds: string[];
  /** T1 apply-as-update (Plaid `modified`): rows updated in place. */
  updatedIds: string[];
  /** T1/T1b: rows skipped as already imported. */
  duplicateCount: number;
  /** Rows skipped because their external id was previously rejected. */
  rejectedCount: number;
  errors: ImportRowIssue[];
}

/** FR-19: a known payee's last-used category, pre-suggested on import. */
export function suggestCategoryId(
  db: Database.Database,
  onBudget: boolean,
  payeeName: string,
): string | null {
  if (!onBudget || payeeName.trim() === '') return null;
  const row = db
    .prepare('SELECT last_category_id FROM payees WHERE name = ? COLLATE NOCASE')
    .get(payeeName.trim()) as { last_category_id: string | null } | undefined;
  return row?.last_category_id ?? null;
}

/** date ± days, pure string-in/string-out (no float math — ADR-004 lint). */
function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const T2_WINDOW_DAYS = 5;

interface CandidateRow {
  id: string;
  status: 'uncleared' | 'cleared' | 'reconciled';
  approved: number;
  import_id: string | null;
  import_batch_id: string | null;
}

export function runImport(db: Database.Database, input: RunImportInput): ImportSummary {
  const run = db.transaction((): ImportSummary => {
    const account = getAccountRow(db, input.accountId); // 404s unknown accounts
    const batchId = randomUUID();
    db.prepare(
      `INSERT INTO import_batches (id, account_id, source, filename, format)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(batchId, account.id, input.source, input.filename ?? null, input.format ?? null);

    const createdIds: string[] = [];
    const mergedIds: string[] = [];
    const updatedIds: string[] = [];
    let duplicateCount = 0;
    let rejectedCount = 0;
    /** Rows created or matched during THIS run — never match targets again. */
    const consumed = new Set<string>();
    /** Duplicate external ids WITHIN the file (a real RBC edge case). */
    const seenExternalIds = new Set<string>();

    const isRejected = db.prepare(
      'SELECT 1 FROM rejected_externals WHERE account_id = ? AND external_id = ?',
    );
    const byExternalId = db.prepare(
      `SELECT id, date, amount_milliunits, status FROM transactions
       WHERE account_id = ? AND import_id = ? AND parent_id IS NULL`,
    );
    // T1b leg 1: an import-borne row (or one already wearing an import id)
    // with the same content identity.
    const byContent = db.prepare(
      `SELECT id FROM transactions
       WHERE account_id = ? AND date = ? AND amount_milliunits = ?
         AND parent_id IS NULL AND is_starting_balance = 0
         AND (source <> 'manual' OR import_id IS NOT NULL)
       ORDER BY rowid`,
    );
    // T1b leg 2: a recorded merge whose IMPORTED side had this content — the
    // surviving row may sit on the manual entry's date, outside leg 1's reach.
    const byMatchContent = db.prepare(
      `SELECT m.transaction_id AS id FROM match_candidates m
       JOIN transactions t ON t.id = m.transaction_id
       WHERE t.account_id = ? AND m.imported_date = ? AND m.imported_amount_milliunits = ?
       ORDER BY m.rowid`,
    );
    // T2: closest-dated unmatched row wins; ties broken by insertion order.
    const t2Candidates = db.prepare(
      `SELECT t.id, t.status, t.approved, t.import_id, t.import_batch_id
       FROM transactions t
       WHERE t.account_id = @accountId AND t.amount_milliunits = @amount
         AND t.date BETWEEN @from AND @to
         AND t.parent_id IS NULL AND t.is_starting_balance = 0
         AND t.import_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM match_candidates m WHERE m.transaction_id = t.id)
       ORDER BY ABS(julianday(t.date) - julianday(@date)), t.rowid`,
    );
    const recordMatch = db.prepare(
      `INSERT INTO match_candidates
         (id, transaction_id, import_batch_id, source, external_id,
          imported_date, imported_payee, imported_memo, imported_amount_milliunits,
          prior_status, prior_approved, prior_import_id, prior_import_batch_id)
       VALUES (@id, @transactionId, @batchId, @source, @externalId,
               @date, @payee, @memo, @amount,
               @priorStatus, @priorApproved, @priorImportId, @priorImportBatchId)`,
    );

    const firstUnconsumed = (rows: { id: string }[]): string | null => {
      for (const row of rows) if (!consumed.has(row.id)) return row.id;
      return null;
    };

    for (const txn of input.staged) {
      // --- T1: exact external id -------------------------------------------
      if (txn.externalId !== null) {
        if (seenExternalIds.has(txn.externalId)) {
          duplicateCount += 1; // duplicate FITID within the file itself
          continue;
        }
        seenExternalIds.add(txn.externalId);
        if (isRejected.get(account.id, txn.externalId)) {
          rejectedCount += 1; // user rejected this bank transaction before (S2 AC-4)
          continue;
        }
        const existing = byExternalId.all(account.id, txn.externalId) as {
          id: string;
          date: string;
          amount_milliunits: number;
          status: 'uncleared' | 'cleared' | 'reconciled';
        }[];
        if (existing.length > 0) {
          const target = existing[0]!;
          const changed =
            target.date !== txn.date || target.amount_milliunits !== txn.amountMilliunits;
          if (input.applyUpdates === true && changed) {
            // T1 apply-as-update (E5.S2 AC-2): the bank revised ITS transaction
            // (pending→posted amount/date change). Bank-owned fields update;
            // the user's category/memo/payee are untouched; the row drops to
            // unapproved so the change surfaces in review (FR-22). `force`
            // because the bank correcting a reconciled copy must not 409 a
            // background sync — the unapproved flag is the user-attention hook.
            updateTransaction(
              db,
              target.id,
              {
                date: txn.date,
                amountMilliunits: milliunits(txn.amountMilliunits),
                ...(target.status === 'uncleared' ? { status: 'cleared' as const } : {}),
              },
              { force: true },
            );
            setImportIdentity(db, target.id, {
              importId: txn.externalId,
              importBatchId: batchId,
              approved: false,
            });
            updatedIds.push(target.id);
          } else {
            duplicateCount += 1; // idempotent re-import (S3 AC-1) or unchanged redelivery
          }
          for (const row of existing) consumed.add(row.id);
          continue;
        }
      } else {
        // --- T1b: content identity for id-less sources (CSV) ----------------
        const dupe =
          firstUnconsumed(byContent.all(account.id, txn.date, txn.amountMilliunits) as { id: string }[]) ??
          firstUnconsumed(
            byMatchContent.all(account.id, txn.date, txn.amountMilliunits) as { id: string }[],
          );
        if (dupe !== null) {
          duplicateCount += 1;
          consumed.add(dupe);
          continue;
        }
      }

      // --- T2: heuristic merge (±5 days, exact amount, unmatched rows only) --
      const candidates = t2Candidates.all({
        accountId: account.id,
        amount: txn.amountMilliunits,
        from: shiftDate(txn.date, -T2_WINDOW_DAYS),
        to: shiftDate(txn.date, T2_WINDOW_DAYS),
        date: txn.date,
      }) as CandidateRow[];
      const target = candidates.find((c) => !consumed.has(c.id));
      if (target !== undefined) {
        recordMatch.run({
          id: randomUUID(),
          transactionId: target.id,
          batchId,
          source: input.source,
          externalId: txn.externalId,
          date: txn.date,
          payee: txn.payee,
          memo: txn.memo,
          amount: txn.amountMilliunits,
          priorStatus: target.status,
          priorApproved: target.approved,
          priorImportId: target.import_id,
          priorImportBatchId: target.import_batch_id,
        });
        // Merge = attach identity + bank-confirmed status, keep the user's
        // category/memo/date untouched, and resurface for review (S3 AC-2/AC-5).
        // A reconciled row keeps its lock — only uncleared steps up to cleared.
        setImportIdentity(db, target.id, {
          importId: txn.externalId,
          importBatchId: batchId,
          ...(target.status === 'uncleared' ? { status: 'cleared' as const } : {}),
          approved: false,
        });
        mergedIds.push(target.id);
        consumed.add(target.id);
        continue;
      }

      // --- T3: new unapproved row, payee canonicalized + category suggested --
      const created = createTransaction(db, {
        accountId: account.id,
        date: txn.date,
        amountMilliunits: milliunits(txn.amountMilliunits),
        payeeName: txn.payee,
        categoryId: suggestCategoryId(db, account.onBudget, txn.payee),
        memo: txn.memo,
        status: 'cleared', // the bank has confirmed it (E2.S6 AC-5)
        approved: false, // FR-22: nothing enters the trusted ledger unseen
        source: input.source,
        importId: txn.externalId,
        importBatchId: batchId,
      });
      createdIds.push(created.id);
      consumed.add(created.id);
    }

    const errors = input.parseErrors ?? [];
    db.prepare(
      `UPDATE import_batches
       SET created_count = ?, merged_count = ?, skipped_count = ?, error_count = ?, errors = ?
       WHERE id = ?`,
    ).run(
      createdIds.length,
      // Batch bookkeeping: T1 updates count with merges ("applied to an
      // existing row") — the summary keeps them distinct for callers.
      mergedIds.length + updatedIds.length,
      duplicateCount + rejectedCount,
      errors.length,
      JSON.stringify(errors),
      batchId,
    );

    return { batchId, createdIds, mergedIds, updatedIds, duplicateCount, rejectedCount, errors };
  });
  return run();
}
