# Story E2.S5: Transfers between accounts

Status: ready-for-dev

## Story

As Calvin, I want transfers between accounts recorded as paired, linked transactions, so that moving money between chequing and savings — or out to the TFSA — keeps every balance right without double entry.

## Context

A transfer is two transaction rows sharing a `transfer_id`; editing or deleting one side cascades to the other. The budget treatment depends on the accounts: on-budget↔on-budget transfers need no category (no budget effect); a transfer involving a tracking account is categorized spending/income on the on-budget side.

## Acceptance Criteria

- **AC-1** Given two on-budget accounts, when Calvin records a $200 transfer from Spending to Savings, then both account balances change by ±$200, no category is required, and RTA and all category balances are untouched. *(FR-16)*
- **AC-2** Given a transfer from chequing (on-budget) to the TFSA (tracking), when saved, then a category is required on the chequing side and that category's available decreases by $200. *(FR-16)*
- **AC-3** Given one side of a transfer, when its amount or date is edited, then the paired row updates to stay consistent; when one side is deleted, the other is removed too. *(FR-16)*
- **AC-4** Given the payee field on a transfer, then it renders as "Transfer: <other account>" and is not added to the suggestable payee list.
- **AC-5** Given cleared status, then each side clears independently (each bank confirms its own side). *(FR-17)*

## Cross-check (do not skip)

- A tracking→tracking transfer (if both accounts are tracking) needs no category and affects no budget math. *(FR-10)*

## Dev Notes

- Pairing model is decided: two rows + shared `transfer_id`, cascade on edit/delete. [architecture §5]
- Transfers also arrive via YNAB migration (E6.S1); keep create/update in the shared ledger command layer.

## Out of Scope

- Transfer matching during import (imports see each side as a normal bank row; matching is E4.S3's heuristic), scheduled transfers (FR-38, P2).

## References

- [Source: docs/prd.md#FR-16] · [Source: docs/prd.md#FR-10]
- [Source: docs/architecture.md#5-domain-model--budget-math]
- [Source: docs/adr/ADR-005]
