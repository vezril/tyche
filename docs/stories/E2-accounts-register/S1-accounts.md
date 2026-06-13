# Story E2.S1: Create and manage accounts (on-budget + tracking)

Status: ready-for-dev

## Story

As Calvin, I want to create, edit, and close on-budget and tracking accounts with starting balances, so that my five real accounts (multiple chequing, one savings, one TFSA tracking) exist in the app and their balances are trustworthy.

## Context

First domain slice. Accounts carry `type` (`chequing|savings|tracking`), an `on_budget` flag, a starting balance, and open/closed state. Cash semantics only — no credit-card accounts or mechanics (NG-3). Tracking accounts are off-budget: their activity must never touch RTA or category math (enforced later by the budget engine, but the flag and balance separation start here).

## Acceptance Criteria

- **AC-1** Given the accounts screen, when Calvin creates an account with a name, type, and starting balance, then the account appears with working balance = starting balance; the starting balance is stored in integer milliunits. *(FR-11, FR-12, FR-32)*
- **AC-2** Given the five account shapes from current usage (multiple chequing, one savings, one tracking asset), when recreated, then each account's working balance equals its starting balance plus the sum of its transactions. *(FR-12)*
- **AC-3** Given a tracking account, when a $500 inflow is recorded to it, then its balance and net-worth contribution change but no category or RTA value changes anywhere. *(FR-10)*
- **AC-4** Given an account with transaction history, when Calvin closes it, then it disappears from active account lists but its transactions remain visible in history; the account can be reopened. *(FR-11)*
- **AC-5** Given any account, then both working and cleared balances are displayed per account (cleared = sum of cleared/reconciled transactions + starting balance). *(FR-12, FR-17)*

## Dev Notes

- Account balances are derived by `SUM()` over transaction rows — never stored. [ADR-005]
- Starting balance may be modeled as a system transaction or a column; either way it must be included in recompute and CSV export later. Keep it auditable. [NFR-12]
- Module: `ledger/`. API: REST resources per ADR-008.

## Out of Scope

- Transactions themselves (E2.S3), cleared-status toggling (E2.S6), Plaid account mapping (E5.S1), net-worth reporting (FR-37, P2).

## References

- [Source: docs/prd.md#FR-10] · [Source: docs/prd.md#FR-11] · [Source: docs/prd.md#FR-12]
- [Source: docs/architecture.md#5-domain-model--budget-math]
- [Source: docs/adr/ADR-004] · [Source: docs/adr/ADR-005]
