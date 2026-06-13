import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { milliunits, type AccountType, type Milliunits } from '@tyche/shared';
import { INFLOW_READY_TO_ASSIGN_CATEGORY_ID } from '../db/seed.js';
import { assertValidIsoDate, LedgerError } from './errors.js';
import { getOrCreatePayee, recordPayeeCategory } from './payees.js';

/**
 * Accounts (E2.S1, FR-10..12).
 *
 * Two structural decisions live here:
 *  - Balances are NEVER stored (ADR-005): working = SUM(all rows), cleared =
 *    SUM(cleared|reconciled rows). There is no aggregate to drift.
 *  - The starting balance is a REAL transaction (is_starting_balance = 1),
 *    cleared, categorized to *Inflow: Ready to Assign* on on-budget accounts
 *    (it is money available to budget) and UNCATEGORIZED on tracking accounts
 *    (FR-10: tracking rows never touch categories/RTA). This keeps balances a
 *    pure fold over rows and the row itself auditable/exportable (NFR-12).
 */

export const STARTING_BALANCE_PAYEE = 'Starting Balance';

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  onBudget: boolean;
  closed: boolean;
}

export interface AccountWithBalances extends Account {
  workingBalanceMilliunits: Milliunits;
  clearedBalanceMilliunits: Milliunits;
}

export interface AccountBalances {
  workingMilliunits: Milliunits;
  clearedMilliunits: Milliunits;
}

export interface CreateAccountInput {
  name: string;
  type: AccountType;
  startingBalanceMilliunits: Milliunits;
  /** YYYY-MM-DD of the starting-balance transaction. */
  startingDate: string;
}

interface AccountRow {
  id: string;
  name: string;
  type: AccountType;
  on_budget: number;
  closed: number;
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    onBudget: row.on_budget === 1,
    closed: row.closed === 1,
  };
}

/** Internal: fetch the raw row or throw. Used by transactions.ts for the tracking rule. */
export function getAccountRow(db: Database.Database, id: string): Account {
  const row = db
    .prepare('SELECT id, name, type, on_budget, closed FROM accounts WHERE id = ?')
    .get(id) as AccountRow | undefined;
  if (!row) throw new LedgerError('account_not_found');
  return toAccount(row);
}

function assertNameAvailable(db: Database.Database, name: string, excludeId?: string): void {
  const clash = db
    .prepare('SELECT id FROM accounts WHERE name = ? COLLATE NOCASE')
    .get(name) as { id: string } | undefined;
  if (clash && clash.id !== excludeId) throw new LedgerError('duplicate_account_name');
}

export function createAccount(db: Database.Database, input: CreateAccountInput): Account {
  const name = input.name.trim();
  if (name === '') throw new LedgerError('invalid_name');
  assertValidIsoDate(input.startingDate);

  const create = db.transaction((): Account => {
    assertNameAvailable(db, name);
    const id = randomUUID();
    const onBudget = input.type === 'tracking' ? 0 : 1;
    db.prepare(
      'INSERT INTO accounts (id, name, type, on_budget, closed) VALUES (?, ?, ?, ?, 0)',
    ).run(id, name, input.type, onBudget);

    // The starting balance: a real cleared row, always created (a $0 row keeps
    // every account's history anchored and auditable — NFR-12, FR-30).
    const payee = getOrCreatePayee(db, STARTING_BALANCE_PAYEE);
    const categoryId = onBudget === 1 ? INFLOW_READY_TO_ASSIGN_CATEGORY_ID : null;
    db.prepare(
      `INSERT INTO transactions
         (id, account_id, date, amount_milliunits, payee_id, category_id, memo,
          status, approved, source, is_starting_balance)
       VALUES (?, ?, ?, ?, ?, ?, '', 'cleared', 1, 'manual', 1)`,
    ).run(
      randomUUID(),
      id,
      input.startingDate,
      input.startingBalanceMilliunits,
      payee!.id,
      categoryId,
    );
    if (categoryId) recordPayeeCategory(db, payee!.id, categoryId);

    return { id, name, type: input.type, onBudget: onBudget === 1, closed: false };
  });
  return create();
}

/** Derived balances (ADR-005): one SUM over the account's rows, never stored. */
export function accountBalances(db: Database.Database, accountId: string): AccountBalances {
  getAccountRow(db, accountId); // 404 before computing on a ghost account
  // parent_id IS NULL: split lines duplicate their parent's total and must
  // never enter a balance sum (E2.S4, migration 0005).
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(amount_milliunits), 0) AS working,
         COALESCE(SUM(CASE WHEN status IN ('cleared', 'reconciled')
                           THEN amount_milliunits ELSE 0 END), 0) AS cleared
       FROM transactions WHERE account_id = ? AND parent_id IS NULL`,
    )
    .get(accountId) as { working: number; cleared: number };
  return {
    workingMilliunits: milliunits(row.working),
    clearedMilliunits: milliunits(row.cleared),
  };
}

export function listAccounts(
  db: Database.Database,
  opts: { includeClosed: boolean },
): AccountWithBalances[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.name, a.type, a.on_budget, a.closed,
              COALESCE(SUM(t.amount_milliunits), 0) AS working,
              COALESCE(SUM(CASE WHEN t.status IN ('cleared', 'reconciled')
                                THEN t.amount_milliunits ELSE 0 END), 0) AS cleared
       FROM accounts a
       LEFT JOIN transactions t ON t.account_id = a.id AND t.parent_id IS NULL
       ${opts.includeClosed ? '' : 'WHERE a.closed = 0'}
       GROUP BY a.id
       ORDER BY a.name COLLATE NOCASE`,
    )
    .all() as (AccountRow & { working: number; cleared: number })[];
  return rows.map((row) => ({
    ...toAccount(row),
    workingBalanceMilliunits: milliunits(row.working),
    clearedBalanceMilliunits: milliunits(row.cleared),
  }));
}

export function getAccount(db: Database.Database, id: string): AccountWithBalances {
  const account = getAccountRow(db, id);
  const balances = accountBalances(db, id);
  return {
    ...account,
    workingBalanceMilliunits: balances.workingMilliunits,
    clearedBalanceMilliunits: balances.clearedMilliunits,
  };
}

export interface UpdateAccountInput {
  name?: string;
  closed?: boolean;
}

export function updateAccount(
  db: Database.Database,
  id: string,
  patch: UpdateAccountInput,
): AccountWithBalances {
  const update = db.transaction(() => {
    getAccountRow(db, id);
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name === '') throw new LedgerError('invalid_name');
      assertNameAvailable(db, name, id);
      db.prepare('UPDATE accounts SET name = ? WHERE id = ?').run(name, id);
    }
    if (patch.closed !== undefined) {
      db.prepare('UPDATE accounts SET closed = ? WHERE id = ?').run(patch.closed ? 1 : 0, id);
    }
  });
  update();
  return getAccount(db, id);
}

/** Closing hides the account from active lists; history stays (FR-11). */
export function closeAccount(db: Database.Database, id: string): AccountWithBalances {
  return updateAccount(db, id, { closed: true });
}

export function reopenAccount(db: Database.Database, id: string): AccountWithBalances {
  return updateAccount(db, id, { closed: false });
}
