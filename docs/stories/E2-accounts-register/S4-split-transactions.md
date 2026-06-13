# Story E2.S4: Split transactions

Status: ready-for-dev

## Story

As Calvin, I want to divide one transaction's amount across multiple categories, so that a single Costco run can hit Groceries and Household correctly.

## Context

A split is a parent transaction with child lines (each line: category, amount, optional memo) that must sum exactly to the parent total. Splits are core YNAB register workflow (AS-5) and must be preserved through migration (FR-30), so the data model here is load-bearing.

## Acceptance Criteria

- **AC-1** Given a transaction, when Calvin converts it to a split and the lines sum exactly to the transaction total, then saving succeeds and each line's amount posts to its category's activity for the month. *(FR-15)*
- **AC-2** Given split lines that do not sum to the transaction total, when save is attempted, then it is rejected with a clear message naming the discrepancy amount. *(FR-15)*
- **AC-3** Given a saved split, when the register displays it, then it shows as one transaction (account balance counts it once) expandable to its lines.
- **AC-4** Given a split, when edited (line added/removed/amount changed) or un-split, then the sum constraint is re-enforced and category activity reflects the new lines. *(FR-15, NFR-12)*
- **AC-5** Given milliunit amounts, then all line arithmetic is integer — lines are entered, not auto-divided; any helper that distributes a remainder must produce integer parts summing exactly to the whole. *(FR-32, ADR-004)*

## Dev Notes

- Model per architecture: child rows referencing the parent; `activity(c, m)` sums *transaction lines*, so the budget engine (E3.S1) must consume lines, not just parents. Coordinate the schema with E3.S1. [architecture §5]
- Splits arrive via migration too (E6.S1) — keep creation logic in the ledger command layer that both UI and importers call. [ADR-001, ADR-006]

## Out of Scope

- Split transfers (a split line that is a transfer — not required by any FR), bulk re-splitting tools.

## References

- [Source: docs/prd.md#FR-15] · [Source: docs/prd.md#AS-5]
- [Source: docs/architecture.md#5-domain-model--budget-math]
- [Source: docs/adr/ADR-004]
