import { CSRF_HEADER, formatMilliunits, milliunits } from '@ynab-clone/shared';

/**
 * Tiny typed fetch layer (ADR-008). Every mutation carries the CSRF header;
 * errors surface as ApiError with the server's machine-readable code so
 * screens can render friendly messages.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    /** Machine-readable specifics (e.g. discrepancyMilliunits, FR-15). */
    public readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

async function fail(res: Response): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { error?: string } & Record<
    string,
    unknown
  >;
  const { error, ...details } = body;
  throw new ApiError(res.status, error ?? `http_${res.status}`, details);
}

export async function apiGet<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) await fail(res);
  return res.json() as Promise<T>;
}

export async function apiSend<T>(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
    body: body === undefined ? null : JSON.stringify(body),
  });
  if (!res.ok) await fail(res);
  return res.json() as Promise<T>;
}

/** Multipart file upload (E4.S1 import); CSRF header like every mutation. */
export async function apiUpload<T>(url: string, file: File): Promise<T> {
  const body = new FormData();
  body.append('file', file);
  const res = await fetch(url, { method: 'POST', headers: { [CSRF_HEADER]: '1' }, body });
  if (!res.ok) await fail(res);
  return res.json() as Promise<T>;
}

/** Multi-file multipart upload (E6 migration: register + plan in one request). */
export async function apiUploadFiles<T>(url: string, files: Record<string, File>): Promise<T> {
  const body = new FormData();
  for (const [field, file] of Object.entries(files)) body.append(field, file);
  const res = await fetch(url, { method: 'POST', headers: { [CSRF_HEADER]: '1' }, body });
  if (!res.ok) await fail(res);
  return res.json() as Promise<T>;
}

/** Human-readable messages for the ledger error codes. */
export function describeError(err: unknown): string {
  if (!(err instanceof ApiError)) return String(err);
  // FR-15: the rejection names the discrepancy amount.
  if (err.code === 'split_sum_mismatch') {
    const raw = err.details['discrepancyMilliunits'];
    if (typeof raw === 'number') {
      const off = formatMilliunits(milliunits(Math.abs(raw)));
      const direction = raw > 0 ? 'over' : 'short of';
      return `Split lines must sum to the transaction total — they are $${off} ${direction} it.`;
    }
    return 'Split lines must sum to the transaction total.';
  }
  const messages: Record<string, string> = {
    invalid_amount: 'Enter a dollars-and-cents amount (whole cents only).',
    invalid_date: 'Enter a valid date (YYYY-MM-DD).',
    invalid_name: 'Enter a name.',
    duplicate_account_name: 'An account with that name already exists.',
    account_not_found: 'Account not found.',
    transaction_not_found: 'Transaction not found.',
    category_not_found: 'Category not found.',
    category_not_allowed_on_tracking_account:
      'Tracking accounts are off-budget — transactions cannot have a category.',
    split_requires_two_lines: 'A split needs at least two lines.',
    split_not_allowed_on_tracking_account:
      'Tracking accounts are off-budget — transactions there cannot be split across categories.',
    category_not_allowed_on_split_parent:
      'A split transaction is categorized through its lines — un-split it to set a single category.',
    split_line_not_addressable: 'Edit split lines through their parent transaction.',
    split_transfer_not_supported: 'A transfer cannot be split (and a split line cannot transfer).',
    transfer_same_account: 'A transfer needs two different accounts.',
    category_required_for_tracking_transfer:
      'Transfers to or from a tracking account need a category on the on-budget side.',
    category_not_allowed_on_transfer:
      'Transfers between two on-budget (or two tracking) accounts have no category.',
    payee_not_allowed_on_transfer: 'Transfer payees are set automatically from the paired account.',
    reconciled_transaction_locked:
      'This transaction is reconciled and locked — confirm to change it anyway.',
    // E3.S4 move money (FR-5)
    move_amount_not_positive: 'Enter a positive amount to move.',
    move_requires_two_categories: 'Pick two different categories to move money between.',
    // E3.S6 category management (FR-9)
    group_not_found: 'Category group not found.',
    duplicate_category_name: 'A category with that name already exists.',
    duplicate_group_name: 'A group with that name already exists.',
    system_protected: 'System categories are protected and cannot be changed.',
    group_not_empty: 'The group must be empty — move or delete its categories first.',
    reassignment_required:
      'This category has history — choose another category to reassign it to first.',
    invalid_reassignment_target: 'Pick a different, assignable category as the target.',
    // E4 file import + review (FR-22..25)
    file_required: 'Choose a file to import.',
    empty_file: 'That file is empty.',
    unsupported_format: 'Unsupported file — export OFX/QFX or CSV from RBC and try again.',
    transaction_already_approved: 'Only unapproved transactions can be rejected — delete it instead.',
    match_not_found: 'This transaction has no import match to undo.',
    // E6 YNAB migration (FR-30/31)
    register_file_required: 'Choose the YNAB Register CSV.',
    plan_file_required: 'Choose the YNAB Plan (budget) CSV.',
    invalid_register_csv: 'That file is not a YNAB register export — expected the Register CSV from the export zip.',
    invalid_plan_csv: 'That file is not a YNAB plan export — expected the Plan/Budget CSV from the export zip.',
    budget_not_empty:
      'Migration only runs into an empty budget. Start from a fresh database (or restore an empty backup) and try again.',
  };
  return messages[err.code] ?? `Unexpected error (${err.status}: ${err.code}).`;
}
