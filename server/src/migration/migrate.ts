import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  milliunits,
  type Milliunits,
  type MigrationDiscrepancy,
  type MigrationParityReport,
  type MigrationResponse,
} from '@tyche/shared';
import {
  INFLOW_READY_TO_ASSIGN_CATEGORY_ID,
  RECONCILIATION_ADJUSTMENT_CATEGORY_ID,
} from '../db/seed.js';
import {
  accountBalances,
  createAccount,
  createTransaction,
  setImportIdentity,
  updateTransaction,
  type Account,
} from '../ledger/index.js';
import {
  BudgetError,
  computeBudget,
  createCategory,
  createGroup,
  loadEngineInputs,
  runConsistencyCheck,
  setAssignedAmount,
  updateCategory,
  updateGroup,
} from '../budget/index.js';
import { MigrationError } from './errors.js';
import { parsePlanCsv, parseRegisterCsv, type PlanRow, type RegisterRow } from './parse.js';

/**
 * The YNAB migration backend (E6.S1/S2, FR-30/31).
 *
 * Structure first, then history, then assignments — every write through the
 * same ledger/budget commands the UI uses (AC-4: identical budget effects),
 * inside ONE SQLite transaction so an unexpected failure can never half-apply
 * (S2 AC-4). The parity + consistency reports are computed AFTER the writes,
 * from the recomputed state. Output is deterministic: rows are processed in
 * source order, so two runs from scratch are row-for-row equivalent (FR-31).
 *
 * Reconstruction decisions (every "tolerant" path writes a discrepancy entry —
 * nothing is ever silently dropped, FR-31):
 *
 *  - ACCOUNT TYPES are not in the export. An account with at least one
 *    categorized row is on-budget ('chequing'); one with none is 'tracking'
 *    (PRD glossary: tracking rows never carry a category — the categorized
 *    side of a mixed transfer is always the on-budget account). The tracking
 *    inference is reported so a mis-typed empty account is visible.
 *  - STARTING BALANCES: YNAB exports the starting balance as a register row
 *    (payee "Starting Balance"). The earliest such row per account becomes the
 *    account's real starting-balance transaction (created by createAccount,
 *    status restored afterwards) instead of importing a duplicate row.
 *  - TRANSFERS appear as paired rows with payee "Transfer : <Account>"; pairs
 *    are RE-LINKED by (date, account pair, ±amount) into one transfer_id with
 *    per-side cleared status/memo. A row whose peer is missing imports as a
 *    plain transaction and is reported — never silently orphaned.
 *  - SPLITS use the old "(Split n/m)" memo convention on consecutive rows
 *    sharing account/date/payee. A complete group becomes parent + lines
 *    (summing exactly, FR-15); an incomplete/ambiguous group imports as
 *    separate transactions and is reported rather than guessed at. Newer
 *    exports carry no marker at all — their lines arrive as separate rows,
 *    which preserves every balance and activity sum by construction.
 *  - "Inflow: Ready to Assign" (also its split-column spelling: group "Inflow"
 *    / category "Ready to Assign") maps onto the seeded system category; YNAB's
 *    "Uncategorized" imports as NULL category and is reported per row.
 *  - FLAGS have no equivalent here; flagged rows import without the flag and
 *    the flag is reported.
 */

export interface RunMigrationInput {
  registerCsv: string;
  planCsv: string;
  registerFilename?: string | null;
  planFilename?: string | null;
}

// --- empty-budget gate (FR-31) -------------------------------------------------

function assertEmptyBudget(db: Database.Database): void {
  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  const found = {
    accounts: count('SELECT COUNT(*) AS n FROM accounts'),
    transactions: count('SELECT COUNT(*) AS n FROM transactions'),
    payees: count('SELECT COUNT(*) AS n FROM payees'),
    categoryGroups: count('SELECT COUNT(*) AS n FROM category_groups WHERE is_system = 0'),
    categories: count('SELECT COUNT(*) AS n FROM categories WHERE is_system = 0'),
    assignments: count('SELECT COUNT(*) AS n FROM month_assignments'),
  };
  if (Object.values(found).some((n) => n > 0)) {
    throw new MigrationError('budget_not_empty', found);
  }
}

// --- category mapping ------------------------------------------------------------

const SPLIT_MEMO = /^\(Split (\d+)\/(\d+)\)\s*/;
const TRANSFER_PAYEE = /^Transfer\s*:\s*(.+)$/;

function isInflowCategory(group: string, category: string): boolean {
  const cat = category.trim().toLowerCase();
  if (cat === 'inflow: ready to assign') return true;
  return group.trim().toLowerCase() === 'inflow' && cat === 'ready to assign';
}

function isUncategorized(category: string): boolean {
  const cat = category.trim().toLowerCase();
  return cat === '' || cat === 'uncategorized';
}

/** Composite key for (group, category); '' cannot appear in CSV fields. */
const catKey = (group: string, category: string): string =>
  `${group.trim().toLowerCase()}${category.trim().toLowerCase()}`;

/** YNAB's pseudo-group for hidden categories — the only hidden signal exports carry. */
const HIDDEN_GROUP = 'hidden categories';

interface CategoryIndex {
  /** (group, category) → created category id. */
  byPair: Map<string, string>;
  /** category name → ids (for combined-column rows that lost their group). */
  byName: Map<string, string[]>;
}

type NoteFn = (source: 'register' | 'plan', line: number | null, reason: string) => void;

// --- the migration ---------------------------------------------------------------

export function runMigration(db: Database.Database, input: RunMigrationInput): MigrationResponse {
  const register = parseRegisterCsv(input.registerCsv);
  const plan = parsePlanCsv(input.planCsv);
  assertEmptyBudget(db);

  const discrepancies: MigrationDiscrepancy[] = [
    ...register.issues.map(
      (i): MigrationDiscrepancy => ({ source: 'register', line: i.line, reason: i.reason }),
    ),
    ...plan.issues.map(
      (i): MigrationDiscrepancy => ({ source: 'plan', line: i.line, reason: i.reason }),
    ),
  ];
  const note: NoteFn = (source, line, reason) => {
    discrepancies.push({ source, line, reason });
  };

  let categoryGroupCount = 0;
  let categoryCount = 0;
  let transactionCount = 0;
  let transferCount = 0;
  let splitCount = 0;
  let assignmentCount = 0;

  const index: CategoryIndex = { byPair: new Map(), byName: new Map() };
  const accountsByName = new Map<string, Account>();
  const batchByAccount = new Map<string, string>();

  const apply = db.transaction((): void => {
    // ---- 1. category structure: plan order first, register stragglers after --
    const groupIds = new Map<string, string>(); // lower-cased name → id
    const hiddenCategoryIds: string[] = [];

    const ensureCategory = (
      source: 'register' | 'plan',
      line: number,
      group: string,
      category: string,
    ): void => {
      if (isInflowCategory(group, category) || isUncategorized(category)) return;
      if (category.trim().toLowerCase() === 'reconciliation adjustment') return; // → system row
      if (group.trim() === '') return; // combined-column orphan: resolved by name at mapping time
      if (index.byPair.has(catKey(group, category))) return;
      try {
        let groupId = groupIds.get(group.trim().toLowerCase());
        if (groupId === undefined) {
          groupId = createGroup(db, group);
          groupIds.set(group.trim().toLowerCase(), groupId);
          categoryGroupCount += 1;
          if (group.trim().toLowerCase() === HIDDEN_GROUP) {
            updateGroup(db, groupId, { hidden: true });
          }
        }
        const id = createCategory(db, groupId, category);
        categoryCount += 1;
        if (group.trim().toLowerCase() === HIDDEN_GROUP) hiddenCategoryIds.push(id);
        index.byPair.set(catKey(group, category), id);
        const names = index.byName.get(category.trim().toLowerCase()) ?? [];
        names.push(id);
        index.byName.set(category.trim().toLowerCase(), names);
      } catch (err) {
        if (err instanceof BudgetError) {
          note(
            source,
            line,
            `cannot create category "${group}: ${category}" (${err.code}) — its rows import uncategorized`,
          );
          return;
        }
        throw err;
      }
    };

    for (const row of plan.rows) ensureCategory('plan', row.line, row.categoryGroup, row.category);
    for (const row of register.rows) {
      ensureCategory('register', row.line, row.categoryGroup, row.category);
    }
    for (const id of hiddenCategoryIds) updateCategory(db, id, { hidden: true });

    /** Map one source row's category to an app category id (or null + note). */
    const mapCategory = (
      source: 'register' | 'plan',
      line: number,
      group: string,
      category: string,
      opts: { noteUncategorized: boolean },
    ): string | null => {
      if (isInflowCategory(group, category)) return INFLOW_READY_TO_ASSIGN_CATEGORY_ID;
      if (isUncategorized(category)) {
        if (opts.noteUncategorized) {
          note(source, line, 'uncategorized in source — imported without a category');
        }
        return null;
      }
      if (category.trim().toLowerCase() === 'reconciliation adjustment') {
        return RECONCILIATION_ADJUSTMENT_CATEGORY_ID;
      }
      const direct = index.byPair.get(catKey(group, category));
      if (direct !== undefined) return direct;
      const byName = index.byName.get(category.trim().toLowerCase()) ?? [];
      if (byName.length === 1) return byName[0]!;
      note(source, line, `unknown category "${group}: ${category}" — imported uncategorized`);
      return null;
    };

    // ---- 2. accounts: inferred type + the consumed Starting Balance row ------
    const accountNames: string[] = [];
    const rowsByAccount = new Map<string, RegisterRow[]>();
    for (const row of register.rows) {
      if (!rowsByAccount.has(row.account)) {
        rowsByAccount.set(row.account, []);
        accountNames.push(row.account);
      }
      rowsByAccount.get(row.account)!.push(row);
    }

    const consumedStartingBalances = new Set<RegisterRow>();
    for (const name of accountNames) {
      const rows = rowsByAccount.get(name)!;
      const onBudget = rows.some((r) => r.category.trim() !== '');
      if (!onBudget) {
        note(
          'register',
          null,
          `account "${name}" has no categorized rows — created as a tracking (off-budget) account`,
        );
      }
      // The earliest "Starting Balance" row IS the starting balance (ties: file order).
      let starting: RegisterRow | undefined;
      for (const r of rows) {
        if (r.payee.trim().toLowerCase() !== 'starting balance') continue;
        if (starting === undefined || r.date < starting.date) starting = r;
      }
      if (starting !== undefined) consumedStartingBalances.add(starting);

      const earliestDate = rows.reduce((min, r) => (r.date < min ? r.date : min), rows[0]!.date);
      const account = createAccount(db, {
        name,
        type: onBudget ? 'chequing' : 'tracking',
        startingBalanceMilliunits: starting?.amountMilliunits ?? milliunits(0),
        startingDate: starting?.date ?? earliestDate,
      });
      accountsByName.set(name, account);
      if (starting !== undefined && starting.status !== 'cleared') {
        // Preserve the source's cleared/reconciled status on the one row
        // createAccount made for us (FR-17/18 fidelity).
        const sbRow = db
          .prepare('SELECT id FROM transactions WHERE account_id = ? AND is_starting_balance = 1')
          .get(account.id) as { id: string };
        setImportIdentity(db, sbRow.id, {
          importId: null,
          importBatchId: null,
          status: starting.status,
        });
      }

      const batchId = randomUUID();
      db.prepare(
        `INSERT INTO import_batches (id, account_id, source, filename, format)
         VALUES (?, ?, 'migration', ?, 'csv')`,
      ).run(batchId, account.id, input.registerFilename ?? null);
      batchByAccount.set(name, batchId);
    }

    // ---- 3. flags: no equivalent here — report, then import the row anyway ---
    for (const row of register.rows) {
      if (row.flag.trim() !== '') {
        note('register', row.line, `flag "${row.flag}" has no equivalent — imported without the flag`);
      }
    }

    const createRegular = (row: RegisterRow, opts: { suppressUncategorizedNote: boolean }): void => {
      const account = accountsByName.get(row.account)!;
      let categoryId: string | null = null;
      if (!account.onBudget) {
        if (row.category.trim() !== '') {
          note(
            'register',
            row.line,
            `category "${row.category}" on tracking account "${row.account}" — tracking rows carry no category, dropped`,
          );
        }
      } else {
        categoryId = mapCategory('register', row.line, row.categoryGroup, row.category, {
          noteUncategorized: !opts.suppressUncategorizedNote,
        });
      }
      createTransaction(db, {
        accountId: account.id,
        date: row.date,
        amountMilliunits: row.amountMilliunits,
        payeeName: row.payee,
        categoryId,
        memo: row.memo.replace(SPLIT_MEMO, ''),
        status: row.status,
        approved: true,
        source: 'migration',
        importBatchId: batchByAccount.get(row.account) ?? null,
      });
      transactionCount += 1;
    };

    // ---- 4. units: split grouping, then transfer pairing ----------------------
    const rows = register.rows.filter((r) => !consumedStartingBalances.has(r));

    // 4a. consecutive "(Split n/m)" runs sharing account/date/payee.
    type BaseUnit = { kind: 'regular'; row: RegisterRow } | { kind: 'split'; rows: RegisterRow[] };
    const units: BaseUnit[] = [];
    let i = 0;
    while (i < rows.length) {
      const row = rows[i]!;
      const marker = SPLIT_MEMO.exec(row.memo);
      if (!marker) {
        units.push({ kind: 'regular', row });
        i += 1;
        continue;
      }
      const run: RegisterRow[] = [row];
      let j = i + 1;
      while (j < rows.length) {
        const next = rows[j]!;
        if (
          next.account !== row.account ||
          next.date !== row.date ||
          next.payee !== row.payee ||
          !SPLIT_MEMO.test(next.memo)
        ) {
          break;
        }
        run.push(next);
        j += 1;
      }
      const total = Number(marker[2]);
      const parts = run.map((r) => Number(SPLIT_MEMO.exec(r.memo)![1]));
      const complete =
        run.length === total &&
        run.every((r) => Number(SPLIT_MEMO.exec(r.memo)![2]) === total) &&
        new Set(parts).size === total &&
        parts.every((p) => p >= 1 && p <= total) &&
        accountsByName.get(row.account)!.onBudget &&
        run.every((r) => !TRANSFER_PAYEE.test(r.payee.trim()));
      if (complete) {
        units.push({ kind: 'split', rows: run });
      } else {
        note(
          'register',
          row.line,
          `split group "${row.payee}" on ${row.date} is incomplete or ambiguous (${run.length} of ${total} parts) — imported as separate transactions`,
        );
        for (const r of run) units.push({ kind: 'regular', row: r });
      }
      i = j;
    }

    // 4b. pair "Transfer : <Account>" rows by (date, account pair, ±amount).
    // First-encountered side of a pair is the primary; matching works in any
    // file order. Leftovers (peer missing from the export) stay regular rows.
    const pending = new Map<string, { row: RegisterRow; target: string }[]>();
    const pairOf = new Map<RegisterRow, RegisterRow>();
    const pairedSecondary = new Set<RegisterRow>();

    for (const unit of units) {
      if (unit.kind !== 'regular') continue;
      const row = unit.row;
      const match = TRANSFER_PAYEE.exec(row.payee.trim());
      if (!match) continue;
      const target = match[1]!.trim();
      if (!accountsByName.has(target) || target === row.account) continue; // → reported as orphan
      const key = [row.date, ...[row.account, target].sort(), Math.abs(row.amountMilliunits)].join(
        '',
      );
      const candidates = pending.get(key) ?? [];
      const matchIndex = candidates.findIndex(
        (c) =>
          c.row.account === target &&
          c.target === row.account &&
          c.row.amountMilliunits === -row.amountMilliunits,
      );
      if (matchIndex !== -1) {
        const [primary] = candidates.splice(matchIndex, 1);
        pairOf.set(primary!.row, row);
        pairedSecondary.add(row);
      } else {
        candidates.push({ row, target });
        pending.set(key, candidates);
      }
    }

    // ---- 5. create everything, in source order --------------------------------
    for (const unit of units) {
      if (unit.kind === 'split') {
        const anchor = unit.rows[0]!;
        const account = accountsByName.get(anchor.account)!;
        let sum = 0;
        for (const r of unit.rows) sum += r.amountMilliunits;
        createTransaction(db, {
          accountId: account.id,
          date: anchor.date,
          amountMilliunits: milliunits(sum),
          payeeName: anchor.payee,
          memo: '',
          status: anchor.status,
          approved: true,
          source: 'migration',
          importBatchId: batchByAccount.get(anchor.account) ?? null,
          splits: unit.rows.map((r) => ({
            categoryId: mapCategory('register', r.line, r.categoryGroup, r.category, {
              noteUncategorized: true,
            }),
            amountMilliunits: r.amountMilliunits,
            memo: r.memo.replace(SPLIT_MEMO, ''),
          })),
        });
        transactionCount += 1;
        splitCount += 1;
        continue;
      }

      const row = unit.row;
      if (pairedSecondary.has(row)) continue; // created together with its primary

      const secondary = pairOf.get(row);
      if (secondary !== undefined) {
        const from = accountsByName.get(row.account)!;
        const to = accountsByName.get(secondary.account)!;
        const mixed = from.onBudget !== to.onBudget;
        const onBudgetSide = from.onBudget ? row : secondary;
        const trackingSide = from.onBudget ? secondary : row;

        let categoryId: string | null = null;
        if (mixed) {
          if (trackingSide.category.trim() !== '') {
            note(
              'register',
              trackingSide.line,
              `category "${trackingSide.category}" on the tracking side of a transfer — tracking rows carry no category, dropped`,
            );
          }
          categoryId = isUncategorized(onBudgetSide.category)
            ? null
            : mapCategory(
                'register',
                onBudgetSide.line,
                onBudgetSide.categoryGroup,
                onBudgetSide.category,
                { noteUncategorized: false },
              );
          if (categoryId === null) {
            // FR-16: the on-budget side of a mixed transfer must carry the
            // category; without one the pair cannot be linked — import both
            // halves as plain rows and say so.
            note(
              'register',
              onBudgetSide.line,
              `transfer "${row.account}" ↔ "${secondary.account}" on ${row.date} has no category on the on-budget side — imported as two separate uncategorized transactions`,
            );
            createRegular(row, { suppressUncategorizedNote: true });
            createRegular(secondary, { suppressUncategorizedNote: true });
            continue;
          }
        } else {
          for (const side of [row, secondary]) {
            if (side.category.trim() !== '') {
              note(
                'register',
                side.line,
                `category "${side.category}" on a same-budget transfer has no effect — dropped`,
              );
            }
          }
        }

        const created = createTransaction(db, {
          accountId: from.id,
          date: row.date,
          amountMilliunits: row.amountMilliunits,
          memo: row.memo,
          status: row.status,
          approved: true,
          source: 'migration',
          importBatchId: batchByAccount.get(row.account) ?? null,
          transferAccountId: to.id,
          ...(mixed ? { categoryId } : {}),
        });
        transactionCount += 1;
        transferCount += 1;

        // Per-side fidelity: the peer keeps ITS OWN memo and cleared status
        // (FR-17, E2.S5 AC-5). force: a reconciled primary must not block
        // restoring the peer's source state.
        const peer = db
          .prepare(
            `SELECT id FROM transactions
             WHERE transfer_id = (SELECT transfer_id FROM transactions WHERE id = ?) AND id <> ?`,
          )
          .get(created.id, created.id) as { id: string };
        if (secondary.memo !== row.memo) {
          updateTransaction(db, peer.id, { memo: secondary.memo }, { force: true });
        }
        if (secondary.status !== row.status) {
          setImportIdentity(db, peer.id, {
            importId: null,
            importBatchId: batchByAccount.get(secondary.account) ?? null,
            status: secondary.status,
          });
        }
        continue;
      }

      // Regular row — including an unpaired transfer reference, which is
      // imported as-is with its "Transfer : X" payee text and reported.
      const orphanTransfer = TRANSFER_PAYEE.test(row.payee.trim());
      if (orphanTransfer) {
        note(
          'register',
          row.line,
          `transfer peer not found for "${row.payee}" on ${row.date} — imported as a regular transaction`,
        );
      }
      createRegular(row, { suppressUncategorizedNote: orphanTransfer });
    }

    // ---- 6. per-month assigned amounts (S2 AC-1) -------------------------------
    for (const row of plan.rows) {
      if (row.budgetedMilliunits === 0) continue; // no zero-row residue (E3.S3)
      if (isInflowCategory(row.categoryGroup, row.category)) {
        note('plan', row.line, 'budgeted amount on Inflow: Ready to Assign cannot be assigned — skipped');
        continue;
      }
      if (isUncategorized(row.category)) {
        note(
          'plan',
          row.line,
          `budgeted amount on "${row.category || 'Uncategorized'}" cannot be assigned — skipped`,
        );
        continue;
      }
      const categoryId = mapCategory('plan', row.line, row.categoryGroup, row.category, {
        noteUncategorized: false,
      });
      if (categoryId === null || categoryId === INFLOW_READY_TO_ASSIGN_CATEGORY_ID) continue;
      setAssignedAmount(db, categoryId, row.month, row.budgetedMilliunits);
      assignmentCount += 1;
    }

    // ---- 7. batch bookkeeping ---------------------------------------------------
    for (const batchId of batchByAccount.values()) {
      const created = db
        .prepare(
          'SELECT COUNT(*) AS n FROM transactions WHERE import_batch_id = ? AND parent_id IS NULL',
        )
        .get(batchId) as { n: number };
      db.prepare('UPDATE import_batches SET created_count = ? WHERE id = ?').run(created.n, batchId);
    }
  });
  apply();

  // ---- 8. parity + consistency, recomputed from the migrated state ------------
  const parity = buildParityReport(db, register.rows, plan.rows, accountsByName, index, note);
  const consistency = runConsistencyCheck(db, parity.month);
  const payeeCount = (db.prepare('SELECT COUNT(*) AS n FROM payees').get() as { n: number }).n;

  return {
    accountCount: accountsByName.size,
    categoryGroupCount,
    categoryCount,
    payeeCount,
    transactionCount,
    transferCount,
    splitCount,
    assignmentCount,
    discrepancies,
    parity,
    consistency: { ok: consistency.ok, mismatches: consistency.mismatches },
  };
}

// --- the FR-30 parity proof -------------------------------------------------------

function buildParityReport(
  db: Database.Database,
  registerRows: RegisterRow[],
  planRows: PlanRow[],
  accountsByName: Map<string, Account>,
  index: CategoryIndex,
  note: NoteFn,
): MigrationParityReport {
  // Migration-day month: the latest month named in the plan (fallback: register).
  let month = '';
  for (const row of planRows) if (row.month > month) month = row.month;
  if (month === '') {
    for (const row of registerRows) {
      const m = row.date.slice(0, 7);
      if (m > month) month = m;
    }
  }

  // Account half: source truth = Σ parsed register amounts per account,
  // computed straight from the source rows — NOT from anything we wrote.
  const sourceBalances = new Map<string, number>();
  for (const row of registerRows) {
    sourceBalances.set(row.account, (sourceBalances.get(row.account) ?? 0) + row.amountMilliunits);
  }
  const accounts = [...accountsByName.entries()].map(([name, account]) => {
    const source = milliunits(sourceBalances.get(name) ?? 0);
    const imported = accountBalances(db, account.id).workingMilliunits;
    return {
      accountName: name,
      sourceBalanceMilliunits: source,
      importedBalanceMilliunits: imported,
      ok: source === imported,
    };
  });

  // Category half: the Plan CSV's own Available for the migration-day month vs
  // the audited fold over the migrated raw rows. computeBudget (not the grid
  // read model) so HIDDEN categories are covered too.
  const folded = computeBudget(loadEngineInputs(db), month).get(month);
  const categories: MigrationParityReport['categories'] = [];
  for (const row of planRows) {
    if (row.month !== month) continue;
    if (isInflowCategory(row.categoryGroup, row.category) || isUncategorized(row.category)) continue;
    const categoryId =
      index.byPair.get(catKey(row.categoryGroup, row.category)) ??
      (index.byName.get(row.category.trim().toLowerCase()) ?? [])[0] ??
      null;
    const computed: Milliunits =
      categoryId === null
        ? milliunits(0)
        : (folded?.categories.get(categoryId)?.availableMilliunits ?? milliunits(0));
    if (categoryId === null) {
      note(
        'plan',
        row.line,
        `category "${row.categoryGroup}: ${row.category}" could not be mapped — its available is unverifiable`,
      );
    }
    categories.push({
      groupName: row.categoryGroup,
      categoryName: row.category,
      sourceAvailableMilliunits: row.availableMilliunits,
      computedAvailableMilliunits: computed,
      ok: categoryId !== null && computed === row.availableMilliunits,
    });
  }

  return {
    month,
    ok: accounts.every((a) => a.ok) && categories.every((c) => c.ok),
    accounts,
    categories,
  };
}
