/** Request/response contracts shared across the API boundary (ADR-002, ADR-008). */

export interface HealthResponse {
  status: 'ok';
  database: 'ok';
}

export interface VersionResponse {
  version: string;
}

export interface SettingResponse {
  key: string;
  value: string;
}

export interface PutSettingRequest {
  value: string;
}

/**
 * CSRF scheme per ADR-008: SameSite=Lax cookie PLUS this custom header on
 * every mutating /api request. Browsers don't attach custom headers on
 * cross-site form/image requests, so its presence proves a same-origin
 * scripted call. The value is irrelevant; presence is the check.
 */
export const CSRF_HEADER = 'x-ynab-csrf';

/** Session cookie name (opaque server-side session id, ADR-008). */
export const SESSION_COOKIE = 'sid';

export interface AuthStatusResponse {
  /** True until the one-time first-run setup has created the single account. */
  setupRequired: boolean;
  /** True when the request carried a valid (unexpired) session. */
  authenticated: boolean;
}

export interface SetupRequest {
  password: string;
}

export interface LoginRequest {
  password: string;
}

export interface AuthOkResponse {
  ok: true;
}

// --- Settings (E1.S3, FR-34) ------------------------------------------------

/** Plaid credential status: the secret is WRITE-ONLY and never appears here. */
export interface PlaidStatusResponse {
  configured: boolean;
  clientId: string | null;
}

export interface SettingsResponse {
  plaid: PlaidStatusResponse;
  pollingIntervalHours: number;
  sessionIdleExpiryDays: number;
}

export interface PutPlaidCredentialsRequest {
  clientId: string;
  /** Encrypted at rest (AES-256-GCM, ADR-007); never returned by any API. */
  secret: string;
}

export interface PutPollingIntervalRequest {
  /** Whole hours between syncs; validated 1–24, default 6. */
  hours: number;
}

export interface PutIdleExpiryRequest {
  /** Whole days a session may idle before expiry; validated 1–365, default 30. */
  days: number;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

// --- Ledger: accounts, transactions, payees (E2.S1–S3, FR-10..14, FR-19) ----
//
// Convention (ADR-004): requests carry user-entered amounts as DOLLAR STRINGS
// ("-138.93") parsed to milliunits at the API boundary (whole cents enforced);
// responses always carry integer milliunits, formatted only at the UI edge.

export type AccountType = 'chequing' | 'savings' | 'tracking';
export type TransactionStatus = 'uncleared' | 'cleared' | 'reconciled';
export type TransactionSource = 'manual' | 'plaid' | 'file' | 'migration';

export interface AccountResponse {
  id: string;
  name: string;
  type: AccountType;
  /** Tracking accounts are off-budget: their rows never touch categories/RTA (FR-10). */
  onBudget: boolean;
  closed: boolean;
  /** Derived on read (ADR-005): SUM of all the account's transactions. */
  workingBalanceMilliunits: number;
  /** Derived on read: SUM of cleared + reconciled transactions only (FR-17). */
  clearedBalanceMilliunits: number;
}

export interface AccountsResponse {
  accounts: AccountResponse[];
}

export interface CreateAccountRequest {
  name: string;
  type: AccountType;
  /** Dollars string; becomes a real, auditable starting-balance transaction (NFR-12). */
  startingBalance: string;
  /** ISO date (YYYY-MM-DD) for the starting-balance transaction; defaults to today. */
  startingDate?: string;
}

export interface UpdateAccountRequest {
  name?: string;
  /** Closing preserves history (FR-11); set false to reopen. */
  closed?: boolean;
}

/** One line of a split transaction (FR-15): category + amount + optional memo. */
export interface SplitLineResponse {
  id: string;
  categoryId: string | null;
  categoryName: string | null;
  /** Signed integer milliunits; all lines sum exactly to the parent's amount. */
  amountMilliunits: number;
  memo: string;
}

export interface TransactionResponse {
  id: string;
  accountId: string;
  /** ISO date YYYY-MM-DD; future dates allowed (FR-14). */
  date: string;
  /** Signed integer milliunits: negative = outflow, positive = inflow. */
  amountMilliunits: number;
  payeeId: string | null;
  payeeName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  memo: string;
  status: TransactionStatus;
  /** Manual entries are approved; imported rows arrive unapproved (FR-22). */
  approved: boolean;
  source: TransactionSource;
  /** True for the account's auditable starting-balance row (FR-11, NFR-12). */
  isStartingBalance: boolean;
  /** Split lines (FR-15); empty for ordinary transactions. */
  lines: SplitLineResponse[];
  /** The paired account when this row is one side of a transfer (FR-16). */
  transferAccountId: string | null;
  /** UI renders the payee as "Transfer: <name>"; never a suggestable payee (S5 AC-4). */
  transferAccountName: string | null;
  /**
   * True when this row carries a T2 merge (manual entry met its bank copy,
   * FR-23) — enriched by the web layer so the register can offer Unmatch
   * (E4.S3 AC-3; the ledger itself never sees import state).
   */
  hasImportMatch?: boolean;
}

/** Per-account register window with filtered totals (FR-13). */
export interface RegisterResponse {
  transactions: TransactionResponse[];
  /** Count of ALL rows matching the filter (window may be smaller). */
  totalCount: number;
  /** SUM over all rows matching the filter, not just the window. */
  filteredTotalMilliunits: number;
  workingBalanceMilliunits: number;
  clearedBalanceMilliunits: number;
}

/** One split line as entered: dollars string, parsed at the boundary (ADR-004). */
export interface SplitLineRequest {
  categoryId?: string | null;
  amount: string;
  memo?: string;
}

export interface CreateTransactionRequest {
  accountId: string;
  date: string;
  /** Signed dollars string ("-45.20" outflow, "45.20" inflow); whole cents only. */
  amount: string;
  /** Free text; canonicalized into the payee list as a side effect (FR-19). */
  payeeName?: string;
  categoryId?: string | null;
  memo?: string;
  /**
   * Split lines (FR-15); must sum to `amount`. Mutually exclusive with
   * `transferAccountId` (split transfers are not required by any FR — rejected).
   */
  splits?: SplitLineRequest[];
  /**
   * The other account of a transfer (FR-16). Creates the paired, linked row in
   * that account for -amount. Mutually exclusive with `payeeName`/`splits`.
   * On-budget↔tracking transfers REQUIRE `categoryId` (it lands on the
   * on-budget side); transfers between two on-budget (or two tracking)
   * accounts must NOT carry one.
   */
  transferAccountId?: string;
}

export interface UpdateTransactionRequest {
  date?: string;
  amount?: string;
  payeeName?: string | null;
  categoryId?: string | null;
  memo?: string;
  /** Replace the split lines wholesale; `null` un-splits (FR-15). */
  splits?: SplitLineRequest[] | null;
  /** Cleared toggle (FR-17). `reconciled` is set only by the reconcile flow (FR-18). */
  status?: 'uncleared' | 'cleared';
}

export interface AccountBalancesResponse {
  accountId: string;
  workingBalanceMilliunits: number;
  clearedBalanceMilliunits: number;
}

/**
 * Mutations return the recomputed balances they affect so the client
 * reconciles optimistic state in one round trip (ADR-005, ADR-008).
 */
export interface TransactionMutationResponse {
  transaction: TransactionResponse;
  accountBalances: AccountBalancesResponse[];
}

export interface DeleteTransactionResponse {
  accountBalances: AccountBalancesResponse[];
}

export interface PayeeResponse {
  id: string;
  name: string;
  /** Last category used with this payee — the default suggestion (FR-19). */
  lastCategoryId: string | null;
  lastCategoryName: string | null;
}

export interface PayeesResponse {
  payees: PayeeResponse[];
}

// --- Category & group management (E3.S6, FR-9) -------------------------------

export interface ManagedCategory {
  id: string;
  name: string;
  /** Hidden rows leave the grid/pickers but keep their history in all math (FR-9). */
  hidden: boolean;
}

export interface ManagedCategoryGroup {
  id: string;
  name: string;
  hidden: boolean;
  /** Ordered; hidden categories included (they stay manageable/unhidable). */
  categories: ManagedCategory[];
}

/**
 * GET /api/categories/structure — the management view: ordered groups with
 * hidden rows included. The protected system group (and its two system
 * categories) is excluded — it is not manageable by design (AC-6).
 * Every category/group mutation responds with this payload.
 */
export interface CategoryStructureResponse {
  groups: ManagedCategoryGroup[];
}

export interface CreateCategoryGroupRequest {
  name: string;
}

/** PATCH /api/category-groups/:id — rename, hide/unhide, and/or reorder. */
export interface UpdateCategoryGroupRequest {
  name?: string;
  hidden?: boolean;
  /** New position among the (non-system) groups, 0-based; clamped. */
  index?: number;
}

export interface CreateCategoryRequest {
  groupId: string;
  name: string;
}

/** PATCH /api/categories/:id — rename, hide/unhide, and/or move within/across groups. */
export interface UpdateCategoryRequest {
  name?: string;
  hidden?: boolean;
  /** Target group (defaults to the current one when only `index` is given). */
  groupId?: string;
  /** New position in the target group, 0-based; clamped; defaults to the end on a group move. */
  index?: number;
}

export interface CategorySummary {
  id: string;
  name: string;
  groupId: string;
  groupName: string;
  isSystem: boolean;
}

export interface CategoriesResponse {
  categories: CategorySummary[];
}

// --- Budget month grid (E3.S1, FR-1..8) ---------------------------------------
//
// Everything here is DERIVED on read from transactions + month_assignments
// (ADR-005): `available = carryover + assigned + activity` (FR-1), carryover
// is `max(0, prior month's available)` (FR-8/AS-1), and
// `RTA(m) = Σ inflows-to-RTA ≤ m − Σ assigned ≤ m − Σ overspend deductions ≤ m`
// (FR-3, where month m's deduction is the sum of month m−1's cash overspends).

/** One category's row in the month grid (FR-1, FR-2). */
export interface BudgetCategoryMonth {
  categoryId: string;
  name: string;
  /** max(0, prior month's available) — AS-1: negatives never carry (FR-8). */
  carryoverMilliunits: number;
  assignedMilliunits: number;
  /** Sum of this month's categorized on-budget transaction lines (FR-1, FR-10). */
  activityMilliunits: number;
  /** carryover + assigned + activity (FR-1). May be negative (overspend). */
  availableMilliunits: number;
}

/** A category group with its rollups = the sums of its visible categories (FR-2). */
export interface BudgetGroupMonth {
  groupId: string;
  name: string;
  assignedMilliunits: number;
  activityMilliunits: number;
  availableMilliunits: number;
  categories: BudgetCategoryMonth[];
}

/** Navigable month range: earliest transaction/assignment month → one month past the latest. */
export interface BudgetMonthBounds {
  minMonth: string;
  maxMonth: string;
}

/** GET /api/budget/:month — the full grid payload (E3.S2 renders exactly this). */
export interface BudgetMonthResponse {
  /** 'YYYY-MM'. */
  month: string;
  /** Ready to Assign for this month (FR-3); negative = over-assigned (FR-6, warn not block). */
  rtaMilliunits: number;
  /** On-budget inflows categorized to Inflow: Ready to Assign, this month only. */
  inflowsMilliunits: number;
  /** Total assigned across ALL categories this month (hidden ones included). */
  assignedThisMonthMilliunits: number;
  /** Prior month's cash overspends charged to this month's RTA (≥ 0, AS-1). */
  overspendDeductedMilliunits: number;
  /** Visible groups in display order, each with visible categories + rollups. */
  groups: BudgetGroupMonth[];
  bounds: BudgetMonthBounds;
}

/** PUT /api/budget/:month/categories/:categoryId — set the assigned amount (E3.S3). */
export interface PutAssignmentRequest {
  /** Signed dollars string ("200.00"); whole cents; "0" clears the assignment. */
  assigned: string;
}

/**
 * POST /api/budget/:month/move — move available money category→category
 * within the month (E3.S4, FR-5). Recorded as PAIRED assignment adjustments
 * (source −amount, destination +amount) in one DB transaction; RTA is
 * unchanged by construction. Responds with the recomputed BudgetMonthResponse.
 */
export interface MoveMoneyRequest {
  fromCategoryId: string;
  toCategoryId: string;
  /** Strictly positive dollars string ("50.00"); whole cents only. */
  amount: string;
}

// --- File import & review queue (E4.S1–S3, FR-22..25, ADR-006) ---------------

/** One unparseable input row, reported with its reason (E4.S1 AC-3). */
export interface ImportRowError {
  /** 1-based line number in the uploaded file. */
  line: number;
  reason: string;
}

/**
 * POST /api/accounts/:id/import (multipart file upload) — the file backend of
 * the importer port. Valid rows run the shared normalize → match → stage
 * pipeline; invalid rows are reported per-row; the whole run is recorded as an
 * ImportBatch with provenance (E4.S1 AC-3).
 */
export interface ImportFileResponse {
  batchId: string;
  format: 'ofx' | 'csv';
  /** New unapproved rows staged for review (T3). */
  createdCount: number;
  /** Rows merged into existing register rows (T2 — FR-23). */
  mergedCount: number;
  /** Rows skipped as already-imported duplicates (T1 / exact re-import). */
  duplicateCount: number;
  /** Rows skipped because their external id was previously rejected (E4.S2 AC-4). */
  rejectedCount: number;
  errors: ImportRowError[];
  accountBalances: AccountBalancesResponse[];
}

/** The T2 merge annotation on a review row (E4.S3 AC-5). */
export interface ReviewMatchInfo {
  matchId: string;
  /** What the bank said, verbatim — so a mis-merge is visible at a glance. */
  importedDate: string;
  importedPayee: string;
  importedAmountMilliunits: number;
  externalId: string | null;
}

/** One row awaiting review (FR-22): unapproved transaction + queue context. */
export interface ReviewItemResponse {
  transaction: TransactionResponse;
  accountName: string;
  /** Present when this row is a T2 merge rather than a plain new import. */
  match: ReviewMatchInfo | null;
  /** Payee's last-used category (FR-19) when the row itself is uncategorized. */
  suggestedCategoryId: string | null;
  suggestedCategoryName: string | null;
}

/** GET /api/review — all unapproved rows across accounts, newest first. */
export interface ReviewQueueResponse {
  items: ReviewItemResponse[];
  totalCount: number;
}

/**
 * POST /api/transactions/:id/approve — flip the approved flag, optionally
 * editing category/payee/memo in the same step. Imported amount and date are
 * NOT editable through approval (E4.S2 AC-2).
 */
export interface ApproveTransactionRequest {
  categoryId?: string | null;
  payeeName?: string | null;
  memo?: string;
}

/**
 * POST /api/transactions/:id/reject — remove the row from the register and
 * remember its external id so the next overlapping import does not recreate
 * it (E4.S2 AC-4). Rejecting a merged row first unmatches it, so the user's
 * own (manual) transaction survives — only the imported copy is rejected.
 */
export interface RejectTransactionResponse {
  /** External id added to the per-account rejected memory, when there was one. */
  rememberedExternalId: string | null;
  accountBalances: AccountBalancesResponse[];
}

/**
 * POST /api/transactions/:id/unmatch — undo a T2 merge (E4.S3 AC-3): the
 * register row reverts to its pre-merge state and the imported transaction
 * reappears as its own unapproved row.
 */
export interface UnmatchTransactionResponse {
  /** The reverted (formerly merged) register row. */
  revertedTransaction: TransactionResponse;
  /** The imported side, restored as a separate unapproved row. */
  restoredTransaction: TransactionResponse;
  accountBalances: AccountBalancesResponse[];
}

// --- Reconciliation (E2.S7, FR-18) -------------------------------------------

export interface ReconcileAccountRequest {
  /** The bank's actual balance as a signed dollars string ("1234.56"). */
  bankBalance: string;
}

export interface ReconcileAccountResponse {
  /**
   * The balance-adjustment transaction created when the bank balance differed
   * from the cleared balance (categorized to the system *Reconciliation
   * adjustment* category on on-budget accounts); null when the difference was $0.
   */
  adjustmentTransaction: TransactionResponse | null;
  /** How many transactions were locked cleared → reconciled. */
  reconciledCount: number;
  accountBalances: AccountBalancesResponse[];
}

// --- Plaid link + sync (E5.S1/S2, FR-20/21/27) --------------------------------

/** ADR-006 Item state machine; S1 drives LINKING → ACTIVE, S4/S5 the rest. */
export type PlaidItemStatus = 'LINKING' | 'ACTIVE' | 'NEEDS_RELINK' | 'UNLINKED';

/** POST /api/plaid/link-token — short-lived token the Link widget opens with. */
export interface PlaidLinkTokenResponse {
  linkToken: string;
}

/** POST /api/plaid/items — exchange the public token Link returned (S1 AC-2). */
export interface CreatePlaidItemRequest {
  publicToken: string;
}

/** One discovered bank account and its mapping decision (FR-20, S1 AC-3). */
export interface PlaidLinkedAccountResponse {
  plaidAccountId: string;
  name: string;
  /** Last digits of the bank account number ("1234"), display only. */
  mask: string | null;
  type: string;
  subtype: string | null;
  /** Mapped app account; null = unmapped or skipped. */
  accountId: string | null;
  accountName: string | null;
  skipped: boolean;
}

/** One sync attempt in the Item's health log (FR-27, S2 AC-7). */
export interface PlaidSyncLogEntryResponse {
  at: string;
  outcome: 'success' | 'error';
  addedCount: number;
  updatedCount: number;
  removedCount: number;
  /** Upstream Plaid error code when outcome='error' (S4 reads ITEM_LOGIN_REQUIRED). */
  errorCode: string | null;
  message: string | null;
}

export interface PlaidItemResponse {
  id: string;
  institutionName: string | null;
  status: PlaidItemStatus;
  accounts: PlaidLinkedAccountResponse[];
  /** Most recent sync attempt, success or not (FR-27). */
  lastAttempt: PlaidSyncLogEntryResponse | null;
  /** Timestamp of the most recent SUCCESSFUL sync. */
  lastSuccessAt: string | null;
  /** Recent attempts, newest first. */
  syncLog: PlaidSyncLogEntryResponse[];
}

export interface PlaidItemsResponse {
  items: PlaidItemResponse[];
}

/** PUT /api/plaid/items/:id/mappings — map/skip each discovered account (S1 AC-3). */
export interface PutPlaidMappingsRequest {
  mappings: {
    plaidAccountId: string;
    /** Existing app account to map to; null when skipping/unmapping. */
    accountId: string | null;
    skipped: boolean;
  }[];
}

/** POST /api/plaid/items/:id/sync — manual "sync now" (FR-21, S2). */
export interface PlaidSyncRunResponse {
  itemId: string;
  /** New register rows (pipeline T3). */
  addedCount: number;
  /** Rows merged into existing register rows (pipeline T2, FR-23). */
  mergedCount: number;
  /** Rows updated in place from Plaid `modified` (S2 AC-2). */
  updatedCount: number;
  /** `removed` upstream → unapproved row voided (S2 AC-3). */
  removedVoidedCount: number;
  /** `removed` upstream → approved row flagged into the review queue (S2 AC-3). */
  removedFlaggedCount: number;
  /** Redeliveries skipped as already imported. */
  duplicateCount: number;
  /** Transactions ignored because their bank account is unmapped/skipped (S2 AC-4). */
  ignoredUnmappedCount: number;
  errors: ImportRowError[];
  accountBalances: AccountBalancesResponse[];
}

// --- YNAB migration (E6.S1/S2, FR-30/31) --------------------------------------

/**
 * One source construct the migration could not map (or mapped with a caveat) —
 * written to the discrepancy report, never silently dropped (FR-31).
 */
export interface MigrationDiscrepancy {
  /** Which uploaded file the entry refers to. */
  source: 'register' | 'plan';
  /** 1-based line in that file; null for whole-source observations. */
  line: number | null;
  reason: string;
}

/** FR-30 Verified-by, account half: working balance vs the source's own sum. */
export interface MigrationAccountParity {
  accountName: string;
  /** Σ register amounts for this account, computed from the SOURCE rows. */
  sourceBalanceMilliunits: number;
  /** The migrated account's recomputed working balance. */
  importedBalanceMilliunits: number;
  ok: boolean;
}

/** FR-30 Verified-by, category half: current-month available vs the Plan CSV. */
export interface MigrationCategoryParity {
  groupName: string;
  categoryName: string;
  /** The Plan CSV's own Available for the migration-day month. */
  sourceAvailableMilliunits: number;
  /** What the budget engine derives from the migrated raw rows. */
  computedAvailableMilliunits: number;
  ok: boolean;
}

/**
 * The machine-checked parity proof the migration outputs (E6.S2 AC-2) —
 * reusable as the SM-1 parallel-run comparison.
 */
export interface MigrationParityReport {
  /** Migration-day month (the latest month in the Plan CSV), 'YYYY-MM'. */
  month: string;
  ok: boolean;
  accounts: MigrationAccountParity[];
  categories: MigrationCategoryParity[];
}

/**
 * POST /api/migration (multipart: `register` + `plan` CSV files) — the YNAB
 * migration backend (FR-30/31). Refuses with 409 `budget_not_empty` unless the
 * budget is untouched, so it is safely re-runnable from scratch.
 */
export interface MigrationResponse {
  accountCount: number;
  categoryGroupCount: number;
  categoryCount: number;
  payeeCount: number;
  /** Register rows imported as transactions (split groups count once). */
  transactionCount: number;
  /** Reconstructed transfer pairs (each pair counts once). */
  transferCount: number;
  /** Reconstructed split transactions (parents). */
  splitCount: number;
  /** MonthAssignment rows written from the Plan CSV (E6.S2 AC-1). */
  assignmentCount: number;
  discrepancies: MigrationDiscrepancy[];
  parity: MigrationParityReport;
  /** NFR-12 consistency check, run on the migrated dataset (E6.S2 AC-6). */
  consistency: { ok: boolean; mismatches: string[] };
}

// --- E7 ops: backup, CSV export, consistency check (FR-35/36, NFR-12) --------

/** One backup artifact in `data/backups/` (E7.S1, FR-35). */
export interface BackupArtifactResponse {
  /** File name of the `.tar.gz` inside the backups directory. */
  name: string;
  sizeBytes: number;
  /** Artifact creation time, ISO-8601. */
  createdAt: string;
}

/** POST /api/admin/backup — run a backup now (E7.S1 AC-1). */
export interface BackupRunResponse {
  artifact: BackupArtifactResponse;
  /** Artifact names removed by the keep-N retention policy during this run. */
  pruned: string[];
}

/** GET /api/admin/backups — newest first. */
export interface BackupsResponse {
  backups: BackupArtifactResponse[];
}

/**
 * One NFR-12 consistency-check run (E7.S4): every displayed balance re-derived
 * from raw rows via an independent path and compared with exact integer
 * equality — no epsilon (AC-4).
 */
export interface ConsistencyCheckResponse {
  ok: boolean;
  /** Per-entity mismatch descriptions, both values included; empty when ok. */
  mismatches: string[];
  /** Coverage counters — proof the check actually walked something. */
  checkedAccounts: number;
  checkedMonths: number;
  /** Budget months were folded through this month. */
  throughMonth: string;
  ranAt: string;
}

/** GET /api/admin/consistency — the boot-time run's result (E7.S4 AC-2). */
export interface BootConsistencyResponse {
  boot: ConsistencyCheckResponse | null;
}
