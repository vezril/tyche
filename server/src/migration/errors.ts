/**
 * Migration-domain errors (E6, FR-30/31), same convention as LedgerError /
 * ImportError: stable machine-readable code, mapped to HTTP status in the web
 * layer and to a message at the UI edge.
 */
export type MigrationErrorCode =
  /** A required upload is missing from the multipart request. */
  | 'register_file_required'
  | 'plan_file_required'
  /** Whole-file failures: the CSV is not a YNAB Register / Plan export. */
  | 'invalid_register_csv'
  | 'invalid_plan_csv'
  /**
   * FR-31: migration targets an EMPTY budget only. Anything already present
   * (accounts, transactions, categories, assignments, payees) → refuse with
   * this code and per-table counts in details — never duplicate or half-apply.
   */
  | 'budget_not_empty';

export class MigrationError extends Error {
  constructor(
    public readonly code: MigrationErrorCode,
    public readonly details?: Record<string, number | string>,
  ) {
    super(code);
    this.name = 'MigrationError';
  }
}
