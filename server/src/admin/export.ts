import type Database from 'better-sqlite3';
import { formatMilliunits, milliunits } from '@ynab-clone/shared';
import { computeBudget } from '../budget/engine.js';
import { loadEngineInputs } from '../budget/queries.js';
import { laterMonth } from '../budget/month.js';
import { INFLOW_READY_TO_ASSIGN_CATEGORY_ID } from '../db/seed.js';

/**
 * CSV export (E7.S2, FR-36, JTBD-4 hostage-proofing).
 *
 * Two exports, both streamed line by line (generators — the route wraps them
 * in a Readable, nothing is buffered):
 *
 *  - REGISTER: one row per accounting line. A split exports as its LINES
 *    (category + amount each) and its parent — whose total merely duplicates
 *    the lines — is omitted, so re-totaling the Amount column per account
 *    reproduces every account balance exactly (FR-36 Verified-by) while
 *    category detail survives. Everything is included: closed accounts,
 *    hidden categories, transfers (peer account named), statuses, approval,
 *    provenance (FR-11 history preservation).
 *
 *  - BUDGET: assigned / activity / available (and carryover) per category per
 *    month, for every month from the first with data through the current one,
 *    straight from the audited engine fold — re-totaling reproduces the grid.
 *
 * Amounts render as exact decimal dollars via the ONE audited milliunit
 * formatter (ADR-004 — float math never touches an amount). Dates are already
 * ISO-8601 in storage.
 */

/** RFC-4180 quoting: quote when the field contains a comma, quote, or newline. */
export function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function csvLine(fields: string[]): string {
  return `${fields.map(csvField).join(',')}\n`;
}

export const REGISTER_CSV_HEADER = [
  'Id',
  'ParentId',
  'Account',
  'AccountClosed',
  'Date',
  'Payee',
  'Category',
  'Memo',
  'Amount',
  'Status',
  'Approved',
  'Source',
  'TransferAccount',
  'IsStartingBalance',
];

interface RegisterRow {
  id: string;
  parentId: string | null;
  account: string;
  accountClosed: number;
  date: string;
  payee: string | null;
  category: string | null;
  memo: string;
  amount: number;
  status: string;
  approved: number;
  source: string;
  transferAccount: string | null;
  isStartingBalance: number;
}

/** The full register as CSV lines (header first), lazily from the DB cursor. */
export function* registerCsvLines(db: Database.Database): Generator<string> {
  yield csvLine(REGISTER_CSV_HEADER);
  // Split parents are excluded (their lines carry the money once); split lines
  // inherit the parent's payee for spreadsheet usefulness. Order: account,
  // then date, then insertion — stable and human-scannable.
  const rows = db
    .prepare(
      `SELECT t.id, t.parent_id AS parentId, a.name AS account, a.closed AS accountClosed,
              t.date, COALESCE(p.name, pp.name) AS payee, c.name AS category, t.memo,
              t.amount_milliunits AS amount, t.status, t.approved, t.source,
              pa.name AS transferAccount, t.is_starting_balance AS isStartingBalance
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN payees p ON p.id = t.payee_id
       LEFT JOIN transactions parent ON parent.id = t.parent_id
       LEFT JOIN payees pp ON pp.id = parent.payee_id
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN transactions peer
         ON t.transfer_id IS NOT NULL AND peer.transfer_id = t.transfer_id AND peer.id <> t.id
       LEFT JOIN accounts pa ON pa.id = peer.account_id
       WHERE NOT EXISTS (SELECT 1 FROM transactions l WHERE l.parent_id = t.id)
       ORDER BY a.name COLLATE NOCASE, t.date, t.rowid`,
    )
    .iterate() as IterableIterator<RegisterRow>;
  for (const row of rows) {
    yield csvLine([
      row.id,
      row.parentId ?? '',
      row.account,
      row.accountClosed === 1 ? 'yes' : 'no',
      row.date,
      row.payee ?? (row.transferAccount !== null ? `Transfer: ${row.transferAccount}` : ''),
      row.category ?? '',
      row.memo,
      formatMilliunits(milliunits(row.amount)),
      row.status,
      row.approved === 1 ? 'yes' : 'no',
      row.source,
      row.transferAccount ?? '',
      row.isStartingBalance === 1 ? 'yes' : 'no',
    ]);
  }
}

export const BUDGET_CSV_HEADER = [
  'Month',
  'CategoryGroup',
  'Category',
  'Hidden',
  'Carryover',
  'Assigned',
  'Activity',
  'Available',
];

interface ExportCategoryRow {
  id: string;
  name: string;
  groupName: string;
  hidden: number;
  groupHidden: number;
}

/**
 * The monthly budget as CSV lines: every category (hidden included — export is
 * everything) for every month from the earliest data month through
 * `currentMonth` (or the latest data month if later).
 */
export function* budgetCsvLines(db: Database.Database, currentMonth: string): Generator<string> {
  yield csvLine(BUDGET_CSV_HEADER);
  const inputs = loadEngineInputs(db);
  if (inputs.earliestDataMonth === null || inputs.latestDataMonth === null) return;
  const throughMonth = laterMonth(inputs.latestDataMonth, currentMonth);
  const folded = computeBudget(inputs, throughMonth);

  const categories = db
    .prepare(
      `SELECT c.id, c.name, g.name AS groupName, c.hidden, g.hidden AS groupHidden
       FROM categories c
       JOIN category_groups g ON g.id = c.group_id
       WHERE c.id <> ?
       ORDER BY g.sort_order, g.name, c.sort_order, c.name`,
    )
    .all(INFLOW_READY_TO_ASSIGN_CATEGORY_ID) as ExportCategoryRow[];

  for (const [month, values] of folded) {
    for (const category of categories) {
      const computed = values.categories.get(category.id);
      yield csvLine([
        month,
        category.groupName,
        category.name,
        category.hidden === 1 || category.groupHidden === 1 ? 'yes' : 'no',
        formatMilliunits(computed?.carryoverMilliunits ?? milliunits(0)),
        formatMilliunits(computed?.assignedMilliunits ?? milliunits(0)),
        formatMilliunits(computed?.activityMilliunits ?? milliunits(0)),
        formatMilliunits(computed?.availableMilliunits ?? milliunits(0)),
      ]);
    }
  }
}
