/**
 * Import-domain errors, same convention as LedgerError: stable
 * machine-readable code, mapped to HTTP status in the web layer and to a
 * message at the UI edge.
 */
export type ImportErrorCode =
  // upload/parse (E4.S1)
  | 'empty_file'
  | 'unsupported_format'
  | 'file_required'
  // review queue (E4.S2)
  | 'transaction_already_approved'
  // matching (E4.S3)
  | 'match_not_found'
  // Plaid link + sync (E5.S1/S2)
  | 'plaid_not_configured'
  | 'plaid_item_not_found'
  | 'plaid_item_not_active'
  | 'plaid_account_link_not_found'
  // stored token undecryptable with the current MASTER_KEY (E7.S1 AC-3, ADR-007)
  | 'plaid_token_unreadable';

export class ImportError extends Error {
  constructor(
    public readonly code: ImportErrorCode,
    public readonly details?: Record<string, number | string>,
  ) {
    super(code);
    this.name = 'ImportError';
  }
}
