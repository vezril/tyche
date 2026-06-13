import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  Milliunits,
  SplitLineResponse,
  TransactionResponse,
  TransactionSource,
  TransactionStatus,
} from '@tyche/shared';
import { milliunits } from '@tyche/shared';
import { getAccountRow, type Account } from './accounts.js';
import { assertValidIsoDate, LedgerError } from './errors.js';
import { getOrCreatePayee, recordPayeeCategory } from './payees.js';

/**
 * Transactions (E2.S2–S7, FR-13..18).
 *
 * All derived numbers are recomputed on read (ADR-005): edits/deletes cannot
 * leave stale aggregates because there are none. The tracking-account rule
 * (FR-10) is enforced at the write edge: a tracking-account row can never
 * carry a category, so E3's activity GROUP BY (which keys on category_id over
 * on-budget accounts) is clean by construction.
 *
 * Representation decisions (see migration 0005 for the schema-side notes):
 *
 *  - SPLITS (FR-15): child rows in the same table with parent_id set. The
 *    parent carries the total and a NULL category; lines carry category +
 *    amount + memo and must sum exactly to the parent. Children mirror the
 *    parent's date/status/approved (kept in sync on every parent write) so
 *    E3's activity sum reads lines with no join. Children are excluded from
 *    every balance SUM and from the register listing (parent_id IS NULL).
 *    Lines are entered, never auto-divided — all arithmetic is integer +/-
 *    (FR-32, ADR-004).
 *
 *  - TRANSFERS (FR-16): two rows sharing a transfer_id. Amount/date edits
 *    cascade to the peer (amount negated) and deletes remove both, atomically
 *    (one SQLite transaction). Cleared status is per-side (FR-17, S5 AC-5).
 *    On-budget↔tracking transfers carry the category on the on-budget side;
 *    same-budget-ness pairs carry none. Transfer rows have NULL payee — the
 *    "Transfer: <account>" pseudo-payee is derived on read and never enters
 *    the suggestable payee list (S5 AC-4).
 *
 *  - A split line that is itself a transfer is NOT required by any FR (S4
 *    out-of-scope) and is explicitly rejected: split_transfer_not_supported.
 *
 *  - RECONCILED LOCK (FR-18): editing or deleting a reconciled row (or the
 *    reconciled peer of a transfer) requires the explicit force flag.
 *
 * This module is also the single write seam for E4/E5: importing creates rows
 * through these same commands (with source/approved overrides), so budget
 * effects are arrival-path independent (FR-25).
 */

export interface SplitLineInput {
  categoryId?: string | null;
  amountMilliunits: Milliunits;
  memo?: string;
}

export interface CreateTransactionInput {
  accountId: string;
  date: string;
  amountMilliunits: Milliunits;
  payeeName?: string | null;
  categoryId?: string | null;
  memo?: string;
  /**
   * Manual entries default to uncleared; plaid/file imports default to
   * cleared — the bank has confirmed them (FR-17, S6 AC-5).
   */
  status?: TransactionStatus;
  approved?: boolean;
  source?: TransactionSource;
  /** External identity for dedup (OFX FITID / Plaid transaction_id) — E4/E5. */
  importId?: string | null;
  /** The ImportBatch that produced this row (provenance, E4.S1 AC-3). */
  importBatchId?: string | null;
  /** Split lines (FR-15); must sum to amountMilliunits. */
  splits?: SplitLineInput[];
  /** Other account of a transfer (FR-16); creates the paired row atomically. */
  transferAccountId?: string;
}

export interface UpdateTransactionInput {
  date?: string;
  amountMilliunits?: Milliunits;
  /** undefined = unchanged; null or '' = remove the payee. */
  payeeName?: string | null;
  /** undefined = unchanged; null = uncategorize. */
  categoryId?: string | null;
  memo?: string;
  /** Replace the lines wholesale; null un-splits (FR-15). */
  splits?: SplitLineInput[] | null;
  /** Cleared toggle (FR-17); 'reconciled' is set only by reconcileAccount (FR-18). */
  status?: 'uncleared' | 'cleared';
}

/** Edits/deletes of reconciled rows require force = explicit user confirmation (FR-18). */
export interface MutationOptions {
  force?: boolean;
}

export interface RegisterQuery {
  /** Free-text substring over payee name and memo (FR-13). */
  search?: string;
  payeeId?: string;
  /** Matches direct categorization OR any split line's category (FR-15). */
  categoryId?: string;
  /** Inclusive YYYY-MM-DD bounds. */
  from?: string;
  to?: string;
  /** Date sort; ties broken by insertion order. Default: latest first. */
  sort?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface RegisterPage {
  transactions: TransactionResponse[];
  totalCount: number;
  filteredTotalMilliunits: Milliunits;
}

interface JoinedRow {
  id: string;
  account_id: string;
  date: string;
  amount_milliunits: number;
  payee_id: string | null;
  payee_name: string | null;
  category_id: string | null;
  category_name: string | null;
  memo: string;
  status: TransactionStatus;
  approved: number;
  source: TransactionSource;
  is_starting_balance: number;
  parent_id: string | null;
  transfer_id: string | null;
  transfer_account_id: string | null;
  transfer_account_name: string | null;
}

const JOINED_SELECT = `
  SELECT t.id, t.account_id, t.date, t.amount_milliunits, t.payee_id,
         p.name AS payee_name, t.category_id, c.name AS category_name,
         t.memo, t.status, t.approved, t.source, t.is_starting_balance,
         t.parent_id, t.transfer_id,
         peer.account_id AS transfer_account_id, pa.name AS transfer_account_name
  FROM transactions t
  LEFT JOIN payees p ON p.id = t.payee_id
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN transactions peer
    ON t.transfer_id IS NOT NULL AND peer.transfer_id = t.transfer_id AND peer.id <> t.id
  LEFT JOIN accounts pa ON pa.id = peer.account_id`;

function toRecord(row: JoinedRow, lines: SplitLineResponse[]): TransactionResponse {
  return {
    id: row.id,
    accountId: row.account_id,
    date: row.date,
    amountMilliunits: row.amount_milliunits,
    payeeId: row.payee_id,
    payeeName: row.payee_name,
    categoryId: row.category_id,
    categoryName: row.category_name,
    memo: row.memo,
    status: row.status,
    approved: row.approved === 1,
    source: row.source,
    isStartingBalance: row.is_starting_balance === 1,
    lines,
    transferAccountId: row.transfer_account_id,
    transferAccountName: row.transfer_account_name,
  };
}

interface LineRow {
  id: string;
  parent_id: string;
  category_id: string | null;
  category_name: string | null;
  amount_milliunits: number;
  memo: string;
}

/** Split lines for a set of parents, in one query (insertion order). */
function linesByParent(
  db: Database.Database,
  parentIds: string[],
): Map<string, SplitLineResponse[]> {
  const map = new Map<string, SplitLineResponse[]>();
  if (parentIds.length === 0) return map;
  const placeholders = parentIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT l.id, l.parent_id, l.category_id, c.name AS category_name,
              l.amount_milliunits, l.memo
       FROM transactions l
       LEFT JOIN categories c ON c.id = l.category_id
       WHERE l.parent_id IN (${placeholders})
       ORDER BY l.rowid`,
    )
    .all(...parentIds) as LineRow[];
  for (const row of rows) {
    const list = map.get(row.parent_id) ?? [];
    list.push({
      id: row.id,
      categoryId: row.category_id,
      categoryName: row.category_name,
      amountMilliunits: row.amount_milliunits,
      memo: row.memo,
    });
    map.set(row.parent_id, list);
  }
  return map;
}

export function getTransaction(db: Database.Database, id: string): TransactionResponse {
  const row = db.prepare(`${JOINED_SELECT} WHERE t.id = ?`).get(id) as JoinedRow | undefined;
  if (!row) throw new LedgerError('transaction_not_found');
  return toRecord(row, linesByParent(db, [row.id]).get(row.id) ?? []);
}

/** Internal: raw row with the structural columns (no joins, no lines). */
function getRawRow(db: Database.Database, id: string): JoinedRow {
  const row = db
    .prepare(
      `SELECT id, account_id, date, amount_milliunits, payee_id, category_id,
              memo, status, approved, source, is_starting_balance, parent_id, transfer_id
       FROM transactions WHERE id = ?`,
    )
    .get(id) as JoinedRow | undefined;
  if (!row) throw new LedgerError('transaction_not_found');
  return row;
}

function getPeerRow(db: Database.Database, row: JoinedRow): JoinedRow {
  const peer = db
    .prepare(
      `SELECT id, account_id, date, amount_milliunits, payee_id, category_id,
              memo, status, approved, source, is_starting_balance, parent_id, transfer_id
       FROM transactions WHERE transfer_id = ? AND id <> ?`,
    )
    .get(row.transfer_id, row.id) as JoinedRow | undefined;
  if (!peer) throw new LedgerError('transaction_not_found');
  return peer;
}

function assertCategoryAssignable(
  db: Database.Database,
  accountOnBudget: boolean,
  categoryId: string | null,
): void {
  if (categoryId === null) return;
  if (!accountOnBudget) throw new LedgerError('category_not_allowed_on_tracking_account');
  const exists = db.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId);
  if (!exists) throw new LedgerError('category_not_found');
}

/** FR-18: reconciled rows are locked; mutating one needs the explicit force flag. */
function assertNotLocked(status: TransactionStatus, force: boolean | undefined): void {
  if (status === 'reconciled' && force !== true) {
    throw new LedgerError('reconciled_transaction_locked');
  }
}

/** Imports arrive bank-confirmed → cleared; manual entry starts uncleared (S6 AC-5). */
function defaultStatus(source: TransactionSource): TransactionStatus {
  return source === 'plaid' || source === 'file' ? 'cleared' : 'uncleared';
}

/**
 * FR-15's load-bearing invariant: ≥2 integer lines whose milliunit amounts
 * sum EXACTLY to the parent total. Plain integer addition only (ADR-004) —
 * nothing here ever divides an amount.
 */
function assertValidSplit(
  db: Database.Database,
  account: Account,
  totalMilliunits: Milliunits,
  lines: SplitLineInput[],
): void {
  if (!account.onBudget) throw new LedgerError('split_not_allowed_on_tracking_account');
  if (lines.length < 2) throw new LedgerError('split_requires_two_lines');
  let sum = 0;
  for (const line of lines) {
    assertCategoryAssignable(db, account.onBudget, line.categoryId ?? null);
    sum += line.amountMilliunits;
  }
  if (sum !== totalMilliunits) {
    // Signed: positive = the lines overshoot the total (Σlines − total).
    throw new LedgerError('split_sum_mismatch', {
      discrepancyMilliunits: sum - totalMilliunits,
    });
  }
}

const INSERT_TRANSACTION = `
  INSERT INTO transactions
    (id, account_id, date, amount_milliunits, payee_id, category_id, memo,
     status, approved, source, import_id, import_batch_id, is_starting_balance,
     parent_id, transfer_id)
  VALUES (@id, @accountId, @date, @amount, @payeeId, @categoryId, @memo,
          @status, @approved, @source, @importId, @importBatchId, 0,
          @parentId, @transferId)`;

interface InsertParams {
  id: string;
  accountId: string;
  date: string;
  amount: number;
  payeeId: string | null;
  categoryId: string | null;
  memo: string;
  status: TransactionStatus;
  approved: number;
  source: TransactionSource;
  importId: string | null;
  importBatchId: string | null;
  parentId: string | null;
  transferId: string | null;
}

function insertSplitLines(
  db: Database.Database,
  parent: Pick<InsertParams, 'accountId' | 'date' | 'status' | 'approved' | 'source'>,
  parentId: string,
  lines: SplitLineInput[],
): void {
  const insert = db.prepare(INSERT_TRANSACTION);
  for (const line of lines) {
    insert.run({
      id: randomUUID(),
      accountId: parent.accountId,
      date: parent.date,
      amount: line.amountMilliunits,
      payeeId: null,
      categoryId: line.categoryId ?? null,
      memo: line.memo ?? '',
      status: parent.status,
      approved: parent.approved,
      source: parent.source,
      importId: null, // import identity lives on the parent only
      importBatchId: null,
      parentId,
      transferId: null,
    } satisfies InsertParams);
  }
}

export function createTransaction(
  db: Database.Database,
  input: CreateTransactionInput,
): TransactionResponse {
  const create = db.transaction((): string => {
    const account = getAccountRow(db, input.accountId);
    assertValidIsoDate(input.date);
    const source = input.source ?? 'manual';
    const status = input.status ?? defaultStatus(source);
    const approved = input.approved === false ? 0 : 1;
    const base = {
      accountId: input.accountId,
      date: input.date,
      memo: input.memo ?? '',
      status,
      approved,
      source,
      importId: input.importId ?? null,
      importBatchId: input.importBatchId ?? null,
    };

    if (input.transferAccountId !== undefined) {
      // --- one side of a transfer (FR-16) ---------------------------------
      if (input.splits !== undefined) throw new LedgerError('split_transfer_not_supported');
      if ((input.payeeName ?? '').trim() !== '') {
        throw new LedgerError('payee_not_allowed_on_transfer');
      }
      const other = getAccountRow(db, input.transferAccountId);
      if (other.id === account.id) throw new LedgerError('transfer_same_account');

      const categoryId = input.categoryId ?? null;
      const mixed = account.onBudget !== other.onBudget;
      if (mixed) {
        // The on-budget side carries the category (PRD glossary, S5 AC-2).
        if (categoryId === null) throw new LedgerError('category_required_for_tracking_transfer');
        assertCategoryAssignable(db, true, categoryId);
      } else if (categoryId !== null) {
        // on↔on (and tracking↔tracking, FR-10 cross-check): no budget effect.
        throw new LedgerError('category_not_allowed_on_transfer');
      }

      const transferId = randomUUID();
      const id = randomUUID();
      const insert = db.prepare(INSERT_TRANSACTION);
      insert.run({
        ...base,
        id,
        amount: input.amountMilliunits,
        payeeId: null,
        categoryId: mixed && account.onBudget ? categoryId : null,
        parentId: null,
        transferId,
      } satisfies InsertParams);
      insert.run({
        ...base,
        id: randomUUID(),
        accountId: other.id,
        amount: milliunits(-input.amountMilliunits),
        payeeId: null,
        categoryId: mixed && other.onBudget ? categoryId : null,
        parentId: null,
        transferId,
      } satisfies InsertParams);
      return id;
    }

    const id = randomUUID();
    const payee = getOrCreatePayee(db, input.payeeName ?? '');

    if (input.splits !== undefined) {
      // --- split parent + lines (FR-15) ------------------------------------
      if (input.categoryId != null) throw new LedgerError('category_not_allowed_on_split_parent');
      assertValidSplit(db, account, input.amountMilliunits, input.splits);
      db.prepare(INSERT_TRANSACTION).run({
        ...base,
        id,
        amount: input.amountMilliunits,
        payeeId: payee?.id ?? null,
        categoryId: null,
        parentId: null,
        transferId: null,
      } satisfies InsertParams);
      insertSplitLines(db, base, id, input.splits);
      return id;
    }

    const categoryId = input.categoryId ?? null;
    assertCategoryAssignable(db, account.onBudget, categoryId);
    db.prepare(INSERT_TRANSACTION).run({
      ...base,
      id,
      amount: input.amountMilliunits,
      payeeId: payee?.id ?? null,
      categoryId,
      parentId: null,
      transferId: null,
    } satisfies InsertParams);
    // FR-19: categorizing a payee teaches the default suggestion.
    if (payee && categoryId) recordPayeeCategory(db, payee.id, categoryId);
    return id;
  });
  return getTransaction(db, create());
}

/** Children mirror the parent's date/status/approved (see header comment). */
function syncChildren(db: Database.Database, parentId: string): void {
  db.prepare(
    `UPDATE transactions
     SET date = (SELECT date FROM transactions WHERE id = @id),
         status = (SELECT status FROM transactions WHERE id = @id),
         approved = (SELECT approved FROM transactions WHERE id = @id)
     WHERE parent_id = @id`,
  ).run({ id: parentId });
}

export function updateTransaction(
  db: Database.Database,
  id: string,
  patch: UpdateTransactionInput,
  opts: MutationOptions = {},
): TransactionResponse {
  const update = db.transaction(() => {
    const existing = getRawRow(db, id);
    if (existing.parent_id !== null) throw new LedgerError('split_line_not_addressable');
    assertNotLocked(existing.status, opts.force);

    const account = getAccountRow(db, existing.account_id);
    const date = patch.date ?? existing.date;
    assertValidIsoDate(date);
    const amount = patch.amountMilliunits ?? milliunits(existing.amount_milliunits);
    const status = patch.status ?? existing.status;
    const memo = patch.memo ?? existing.memo;
    const isTransfer = existing.transfer_id !== null;
    const childCount = (
      db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE parent_id = ?').get(id) as {
        n: number;
      }
    ).n;

    const categoryId = patch.categoryId === undefined ? existing.category_id : patch.categoryId;
    let payeeId = existing.payee_id;
    let newLines: SplitLineInput[] | null = null; // null = keep current lines

    if (isTransfer) {
      // --- transfer side: cascade + category rules (FR-16) -----------------
      if (patch.payeeName !== undefined) throw new LedgerError('payee_not_allowed_on_transfer');
      if (Array.isArray(patch.splits)) throw new LedgerError('split_transfer_not_supported');
      const peer = getPeerRow(db, existing);
      const other = getAccountRow(db, peer.account_id);
      const mixed = account.onBudget !== other.onBudget;
      if (mixed && account.onBudget && categoryId === null) {
        throw new LedgerError('category_required_for_tracking_transfer');
      }
      if (!mixed && categoryId !== null) throw new LedgerError('category_not_allowed_on_transfer');
      assertCategoryAssignable(db, account.onBudget, categoryId);

      // Amount/date keep the pair consistent (S5 AC-3); status stays per-side
      // (S5 AC-5). Touching a reconciled peer also needs the force flag (FR-18).
      if (amount !== existing.amount_milliunits || date !== existing.date) {
        assertNotLocked(peer.status, opts.force);
        db.prepare('UPDATE transactions SET amount_milliunits = ?, date = ? WHERE id = ?').run(
          milliunits(-amount),
          date,
          peer.id,
        );
      }
    } else if (Array.isArray(patch.splits)) {
      // --- (re-)split: replace the lines wholesale (FR-15, S4 AC-4) ---------
      if (categoryId !== null) throw new LedgerError('category_not_allowed_on_split_parent');
      assertValidSplit(db, account, amount, patch.splits);
      newLines = patch.splits;
    } else if (patch.splits === null) {
      // --- un-split: drop the lines; a direct category may be set -----------
      assertCategoryAssignable(db, account.onBudget, categoryId);
      db.prepare('DELETE FROM transactions WHERE parent_id = ?').run(id);
    } else if (childCount > 0) {
      // --- existing split, lines untouched: re-enforce the invariants -------
      if (categoryId !== null) throw new LedgerError('category_not_allowed_on_split_parent');
      if (amount !== existing.amount_milliunits) {
        // The unchanged lines still sum to the OLD total — name the gap (FR-15).
        throw new LedgerError('split_sum_mismatch', {
          discrepancyMilliunits: existing.amount_milliunits - amount,
        });
      }
    } else {
      assertCategoryAssignable(db, account.onBudget, categoryId);
    }

    if (!isTransfer && patch.payeeName !== undefined) {
      payeeId = getOrCreatePayee(db, patch.payeeName ?? '')?.id ?? null;
    }

    db.prepare(
      `UPDATE transactions
       SET date = ?, amount_milliunits = ?, payee_id = ?, category_id = ?, memo = ?, status = ?
       WHERE id = ?`,
    ).run(date, amount, payeeId, categoryId, memo, status, id);

    if (newLines !== null) {
      db.prepare('DELETE FROM transactions WHERE parent_id = ?').run(id);
      insertSplitLines(
        db,
        { accountId: existing.account_id, date, status, approved: existing.approved, source: existing.source },
        id,
        newLines,
      );
    } else {
      syncChildren(db, id);
    }

    if (payeeId && categoryId && categoryId !== existing.category_id) {
      recordPayeeCategory(db, payeeId, categoryId);
    }
  });
  update();
  return getTransaction(db, id);
}

/** Returns the accounts whose balances the deletion changed (both, for a transfer). */
export function deleteTransaction(
  db: Database.Database,
  id: string,
  opts: MutationOptions = {},
): { accountIds: string[] } {
  const del = db.transaction((): string[] => {
    const existing = getRawRow(db, id);
    if (existing.parent_id !== null) throw new LedgerError('split_line_not_addressable');
    assertNotLocked(existing.status, opts.force);
    const accountIds = [existing.account_id];

    if (existing.transfer_id !== null) {
      // Deleting one side removes the other, atomically (FR-16, S5 AC-3).
      const peer = getPeerRow(db, existing);
      assertNotLocked(peer.status, opts.force);
      db.prepare('DELETE FROM transactions WHERE id = ?').run(peer.id);
      if (!accountIds.includes(peer.account_id)) accountIds.push(peer.account_id);
    }

    db.prepare('DELETE FROM transactions WHERE parent_id = ?').run(id);
    db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
    return accountIds;
  });
  return { accountIds: del() };
}

/**
 * Review-queue approval (E4.S2, FR-22): flip the approved flag, optionally
 * editing category/payee/memo in the same step. The edit surface is the
 * TYPE — amount and date are not accepted here, so approval can never alter
 * the imported amount/date identity (S2 AC-2). All edit rules (tracking
 * accounts, transfers, splits) are enforced by routing through
 * updateTransaction.
 */
export interface ApproveTransactionEdits {
  categoryId?: string | null;
  payeeName?: string | null;
  memo?: string;
}

export function approveTransaction(
  db: Database.Database,
  id: string,
  edits: ApproveTransactionEdits = {},
): TransactionResponse {
  const approve = db.transaction(() => {
    const existing = getRawRow(db, id);
    if (existing.parent_id !== null) throw new LedgerError('split_line_not_addressable');
    const patch: UpdateTransactionInput = {};
    if (edits.categoryId !== undefined) patch.categoryId = edits.categoryId;
    if (edits.payeeName !== undefined) patch.payeeName = edits.payeeName;
    if (edits.memo !== undefined) patch.memo = edits.memo;
    if (Object.keys(patch).length > 0) updateTransaction(db, id, patch);
    db.prepare('UPDATE transactions SET approved = 1 WHERE id = ?').run(id);
    syncChildren(db, id);
    // FR-19 / S2 AC-5: approving CONFIRMS this payee→category pairing — teach
    // the suggestion even when the category was pre-filled rather than edited.
    const after = getRawRow(db, id);
    if (after.payee_id !== null && after.category_id !== null) {
      recordPayeeCategory(db, after.payee_id, after.category_id);
    }
  });
  approve();
  return getTransaction(db, id);
}

/**
 * Attach or detach a transaction's import identity (E4.S3 merge/unmatch).
 * This is the ledger-seam write the importing pipeline uses for T2 merges
 * (gain external id + cleared status, drop to unapproved for review) and for
 * the unmatch revert — matching POLICY lives in importing/, but the write
 * happens here like every other ledger write (ADR-001, FR-25).
 */
export interface ImportIdentityPatch {
  importId: string | null;
  importBatchId: string | null;
  status?: TransactionStatus;
  approved?: boolean;
}

export function setImportIdentity(
  db: Database.Database,
  id: string,
  patch: ImportIdentityPatch,
): TransactionResponse {
  const apply = db.transaction(() => {
    const existing = getRawRow(db, id);
    if (existing.parent_id !== null) throw new LedgerError('split_line_not_addressable');
    const status = patch.status ?? existing.status;
    const approved =
      patch.approved === undefined ? existing.approved : patch.approved ? 1 : 0;
    db.prepare(
      `UPDATE transactions
       SET import_id = ?, import_batch_id = ?, status = ?, approved = ?
       WHERE id = ?`,
    ).run(patch.importId, patch.importBatchId, status, approved, id);
    syncChildren(db, id);
  });
  apply();
  return getTransaction(db, id);
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** The per-account register: windowed rows + whole-filter totals (FR-13). */
export function getRegister(
  db: Database.Database,
  accountId: string,
  query: RegisterQuery = {},
): RegisterPage {
  getAccountRow(db, accountId); // 404 on unknown accounts, closed ones included

  // Split lines never appear as register rows (and never enter the totals):
  // the parent shows once, expandable to its lines (S4 AC-3).
  const clauses = ['t.account_id = @accountId', 't.parent_id IS NULL'];
  const params: Record<string, unknown> = { accountId };
  if (query.search !== undefined && query.search !== '') {
    clauses.push("(p.name LIKE '%' || @search || '%' OR t.memo LIKE '%' || @search || '%')");
    params['search'] = query.search;
  }
  if (query.payeeId !== undefined) {
    clauses.push('t.payee_id = @payeeId');
    params['payeeId'] = query.payeeId;
  }
  if (query.categoryId !== undefined) {
    // A split matches a category filter through any of its lines (FR-15).
    clauses.push(
      `(t.category_id = @categoryId OR EXISTS (
         SELECT 1 FROM transactions line
         WHERE line.parent_id = t.id AND line.category_id = @categoryId))`,
    );
    params['categoryId'] = query.categoryId;
  }
  if (query.from !== undefined) {
    assertValidIsoDate(query.from);
    clauses.push('t.date >= @from');
    params['from'] = query.from;
  }
  if (query.to !== undefined) {
    assertValidIsoDate(query.to);
    clauses.push('t.date <= @to');
    params['to'] = query.to;
  }
  const where = clauses.join(' AND ');
  const order = query.sort === 'asc' ? 'ASC' : 'DESC';

  const rows = db
    .prepare(
      `${JOINED_SELECT}
       WHERE ${where}
       ORDER BY t.date ${order}, t.rowid ${order}
       LIMIT @limit OFFSET @offset`,
    )
    .all({
      ...params,
      limit: Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
      offset: query.offset ?? 0,
    }) as JoinedRow[];

  // Totals cover the WHOLE filtered set, not just the window (S2 AC-3).
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(t.amount_milliunits), 0) AS total
       FROM transactions t
       LEFT JOIN payees p ON p.id = t.payee_id
       WHERE ${where}`,
    )
    .get(params) as { n: number; total: number };

  const lines = linesByParent(
    db,
    rows.map((r) => r.id),
  );
  return {
    transactions: rows.map((row) => toRecord(row, lines.get(row.id) ?? [])),
    totalCount: totals.n,
    filteredTotalMilliunits: milliunits(totals.total),
  };
}
