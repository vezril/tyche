/**
 * The Plaid client seam (E5.S1/S2, ADR-006). Everything in importing/plaid
 * talks to Plaid ONLY through this narrow port, so the test suite injects a
 * fake here and never touches the network; the one real implementation
 * (sdk.ts, wrapping the official `plaid` package per ADR-002) is constructed
 * by the web layer from the stored credentials (admin/plaid.ts) — importing
 * may not import admin (ADR-001), so credentials arrive pre-resolved.
 *
 * Amounts cross this seam as DECIMAL STRINGS in Plaid's sign convention
 * (positive = money leaves the account). Milliunits are parsed from the
 * string with the audited shared parser — never via float math (ADR-004,
 * S2 AC-1).
 */

/** A bank account discovered on a linked Item (FR-20). */
export interface PlaidDiscoveredAccount {
  /** Plaid's stable account_id — becomes StagedTransaction.accountHint. */
  plaidAccountId: string;
  name: string;
  /** Last digits of the account number, for display ("•• 1234"). */
  mask: string | null;
  type: string;
  subtype: string | null;
}

/** One transaction from /transactions/sync `added`/`modified`. */
export interface PlaidTransactionData {
  /** Plaid's stable transaction_id — the T1 external id. */
  transactionId: string;
  plaidAccountId: string;
  /** ISO YYYY-MM-DD. */
  date: string;
  /** Counterparty/description (merchant name when Plaid resolved one). */
  name: string;
  /**
   * Signed decimal string, PLAID's convention: positive = outflow.
   * The pipeline stores the ledger convention (outflow negative).
   */
  amount: string;
  /** Pending flag rides only into `raw` — not modeled (ADR-006). */
  pending: boolean;
  /** Verbatim upstream payload, preserved for provenance. */
  raw: unknown;
}

export interface PlaidRemovedTransaction {
  transactionId: string;
  plaidAccountId: string | null;
}

/** One page of /transactions/sync. */
export interface PlaidSyncPage {
  added: PlaidTransactionData[];
  modified: PlaidTransactionData[];
  removed: PlaidRemovedTransaction[];
  nextCursor: string;
  hasMore: boolean;
}

export interface PlaidExchangeResult {
  accessToken: string;
  plaidItemId: string;
}

export interface PlaidItemAccounts {
  institutionName: string | null;
  accounts: PlaidDiscoveredAccount[];
}

/** What the importing module needs from Plaid — nothing more. */
export interface PlaidClientPort {
  /** POST /link/token/create → short-lived token the Link widget opens with. */
  createLinkToken(): Promise<string>;
  /**
   * POST /link/token/create in UPDATE MODE (E5.S4, FR-26): the token carries
   * the broken Item's access token, so Link re-authenticates the SAME Item —
   * cursor and account mappings survive, no new Item is created.
   */
  createUpdateLinkToken(accessToken: string): Promise<string>;
  /** POST /item/public_token/exchange → permanent access token + item id. */
  exchangePublicToken(publicToken: string): Promise<PlaidExchangeResult>;
  /** GET /accounts (+ institution) for the freshly linked Item. */
  getItemAccounts(accessToken: string): Promise<PlaidItemAccounts>;
  /** POST /transactions/sync — cursor null/'' means "from the beginning". */
  transactionsSync(accessToken: string, cursor: string | null): Promise<PlaidSyncPage>;
  /** POST /item/remove — revoke the access token at Plaid (E5.S5, FR-28). */
  removeItem(accessToken: string): Promise<void>;
}

/**
 * Plaid told us to restart pagination: the underlying data mutated while we
 * were paging. Per Plaid docs the loop restarts from the last APPLIED cursor
 * — which is exactly what plaid_items.cursor holds, because pages are applied
 * transactionally cursor-and-data together (S2 AC-5).
 */
export const PLAID_MUTATION_ERROR = 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION';

/**
 * The bank connection needs re-authentication (E5.S4, FR-26, AS-10): an
 * expected operating condition with RBC, not a defect. A sync failing with
 * this code flips the Item ACTIVE → NEEDS_RELINK; recovery is Link update mode.
 */
export const PLAID_ITEM_LOGIN_REQUIRED = 'ITEM_LOGIN_REQUIRED';

/** Upstream Plaid API failure, carrying the Plaid error code for the sync log (FR-27). */
export class PlaidApiError extends Error {
  constructor(
    public readonly plaidCode: string,
    message?: string,
  ) {
    super(message ?? plaidCode);
    this.name = 'PlaidApiError';
  }
}
