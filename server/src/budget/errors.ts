/**
 * budget module domain errors (E3.S1), mirroring the ledger convention:
 * a stable machine-readable code the web layer maps to an HTTP status.
 */
export type BudgetErrorCode =
  | 'category_not_found'
  | 'cannot_assign_to_inflow_category'
  | 'invalid_month'
  | 'move_amount_not_positive'
  | 'move_requires_two_categories'
  // E3.S6 category/group management (FR-9):
  | 'group_not_found'
  | 'invalid_name'
  | 'duplicate_category_name'
  | 'duplicate_group_name'
  | 'system_protected'
  | 'group_not_empty'
  | 'reassignment_required'
  | 'invalid_reassignment_target';

export class BudgetError extends Error {
  constructor(public readonly code: BudgetErrorCode) {
    super(code);
    this.name = 'BudgetError';
  }
}
