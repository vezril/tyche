/**
 * importing module (ADR-001, ADR-006): the importer port with pluggable
 * backends (filefmt/ now; plaid/ in E5, ynab-migration/ in E6) and the shared
 * normalize → match → review pipeline every backend feeds (E4.S1–S3).
 *
 * This file is the module's ONLY public surface. Boundary rules (enforced by
 * eslint, AC-5): importing never imports from budget (FR-25 — budget math is
 * provenance-independent), and ALL ledger writes go through ledger/index.ts.
 */
export { ImportError, type ImportErrorCode } from './errors.js';
export type { ImportRowIssue, ParsedImport, StagedTransaction } from './port.js';
export {
  detectFormat,
  parseImportFile,
  parseOfx,
  parseRbcCsv,
  type FileFormat,
  type ParsedImportFile,
} from './filefmt/index.js';
export {
  runImport,
  suggestCategoryId,
  type ImportSource,
  type ImportSummary,
  type RunImportInput,
} from './pipeline.js';
export {
  listReviewQueue,
  matchedTransactionIds,
  rejectTransaction,
  unmatchTransaction,
  type RejectResult,
  type UnmatchResult,
} from './review.js';
// --- Plaid backend (E5.S1/S2, FR-20/21) -------------------------------------
export {
  PLAID_ITEM_LOGIN_REQUIRED,
  PLAID_MUTATION_ERROR,
  PlaidApiError,
  type PlaidClientPort,
  type PlaidDiscoveredAccount,
  type PlaidExchangeResult,
  type PlaidItemAccounts,
  type PlaidRemovedTransaction,
  type PlaidSyncPage,
  type PlaidTransactionData,
} from './plaid/client.js';
export {
  applyAccountMappings,
  appendSyncLog,
  completeRelink,
  createLinkedItem,
  getAccessToken,
  getPlaidItem,
  lastSuccessfulSyncAt,
  listAccountLinks,
  listPlaidItems,
  listSyncLog,
  markNeedsRelink,
  unlinkPlaidItem,
  type AccountMappingInput,
  type CreateLinkedItemInput,
  type PlaidAccountLink,
  type PlaidItemRecord,
  type PlaidItemStatus,
  type PlaidSyncLogEntry,
} from './plaid/items.js';
export {
  plaidAmountToMilliunits,
  REMOVED_BY_BANK_NOTE,
  syncPlaidItem,
  type PlaidSyncResult,
} from './plaid/sync.js';
export {
  createPlaidSdkClient,
  type PlaidClientFactory,
  type PlaidCredentials,
  type PlaidEnvironmentName,
} from './plaid/sdk.js';
