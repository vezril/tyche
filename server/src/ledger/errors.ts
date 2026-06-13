/**
 * Domain errors carry a stable machine-readable code; the web layer maps the
 * code to an HTTP status and the client to a message. Throwing (rather than
 * result types) matches the existing auth/admin modules.
 */
export type LedgerErrorCode =
  | 'account_not_found'
  | 'transaction_not_found'
  | 'category_not_found'
  | 'duplicate_account_name'
  | 'invalid_name'
  | 'invalid_date'
  | 'category_not_allowed_on_tracking_account'
  // splits (E2.S4, FR-15)
  | 'split_sum_mismatch'
  | 'split_requires_two_lines'
  | 'split_not_allowed_on_tracking_account'
  | 'category_not_allowed_on_split_parent'
  | 'split_line_not_addressable'
  // split×transfer interaction is not required by any FR — explicitly rejected
  | 'split_transfer_not_supported'
  // transfers (E2.S5, FR-16)
  | 'transfer_same_account'
  | 'category_required_for_tracking_transfer'
  | 'category_not_allowed_on_transfer'
  | 'payee_not_allowed_on_transfer'
  // reconciled rows are locked: edits/deletes need an explicit force (FR-18)
  | 'reconciled_transaction_locked';

export class LedgerError extends Error {
  /**
   * @param details machine-readable specifics the web layer forwards verbatim
   * (e.g. `{ discrepancyMilliunits }` on split_sum_mismatch — FR-15 requires
   * the rejection to NAME the discrepancy amount).
   */
  constructor(
    public readonly code: LedgerErrorCode,
    public readonly details?: Record<string, number | string>,
  ) {
    super(code);
    this.name = 'LedgerError';
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Strict YYYY-MM-DD calendar date (round-trips through Date, so 2026-02-30 fails). */
export function assertValidIsoDate(date: string): void {
  if (ISO_DATE.test(date)) {
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(date)) return;
  }
  throw new LedgerError('invalid_date');
}
