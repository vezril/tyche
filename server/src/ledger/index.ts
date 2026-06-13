/**
 * ledger module (ADR-001): accounts, transactions, splits, transfers,
 * clearing, reconcile, payees (FR-10..19).
 *
 * This file is the module's ONLY public surface. Boundary rules (enforced by
 * eslint, E1.S1 AC-5): ledger never imports from budget/importing/auth/admin/
 * web. importing (E4/E5) writes to the ledger only through these same
 * commands, which is what makes budget effects arrival-path independent
 * (FR-25).
 */
export {
  accountBalances,
  closeAccount,
  createAccount,
  getAccount,
  getAccountRow,
  listAccounts,
  reopenAccount,
  STARTING_BALANCE_PAYEE,
  updateAccount,
  type Account,
  type AccountBalances,
  type AccountWithBalances,
  type CreateAccountInput,
  type UpdateAccountInput,
} from './accounts.js';
export {
  approveTransaction,
  createTransaction,
  deleteTransaction,
  getRegister,
  getTransaction,
  setImportIdentity,
  updateTransaction,
  type ApproveTransactionEdits,
  type CreateTransactionInput,
  type ImportIdentityPatch,
  type MutationOptions,
  type RegisterPage,
  type RegisterQuery,
  type SplitLineInput,
  type UpdateTransactionInput,
} from './transactions.js';
export {
  reconcileAccount,
  RECONCILIATION_ADJUSTMENT_PAYEE,
  type ReconcileInput,
  type ReconcileResult,
} from './reconcile.js';
export {
  getOrCreatePayee,
  recordPayeeCategory,
  searchPayees,
  type Payee,
} from './payees.js';
export { LedgerError, type LedgerErrorCode } from './errors.js';
