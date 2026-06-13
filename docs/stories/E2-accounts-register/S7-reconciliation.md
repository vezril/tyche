# Story E2.S7: Account reconciliation flow

Status: ready-for-dev

## Story

As Calvin, I want a guided reconciliation that compares my cleared balance to the bank's actual balance and locks the result, so that I can periodically assert the ledger matches reality (UJ-8).

## Context

Reconciliation is the trust ritual: enter the bank's balance, resolve the difference, lock. Any residual difference becomes a balance-adjustment transaction categorized to the system *Reconciliation adjustment* category. All cleared transactions then become `reconciled`. Depends on E2.S6 (cleared states).

## Acceptance Criteria

- **AC-1** Given an account, when Calvin starts reconciliation and enters the bank's actual balance, then the app shows the difference between that figure and the current cleared balance. *(FR-18)*
- **AC-2** Given a nonzero difference, when Calvin accepts the offered adjustment, then a balance-adjustment transaction for exactly the difference is created (cleared, categorized to the *Reconciliation adjustment* system category) and the difference becomes $0. *(FR-18)*
- **AC-3** Given a zero difference, when reconciliation completes, then all currently-cleared transactions in the account are marked `reconciled` and the post-reconciliation cleared balance equals the entered bank balance. *(FR-18)*
- **AC-4** Given a reconciled transaction, when an edit or delete is attempted later, then explicit confirmation is required before proceeding. *(FR-18)*
- **AC-5** Given uncleared transactions during the flow, then they are listed for quick cleared-toggling without leaving the reconciliation context (the SM-3 duplicate counter-metric is observed here in practice). *(FR-17, NFR-9)*

## Dev Notes

- The *Reconciliation adjustment* system category is seeded at first-run initialization in E1.S1 (this story does not create it); adjustments are on-budget spending/income, so they affect that category's activity and budget math normally. [architecture §5]
- No "reconciliation report" entity is required — the locked statuses plus the adjustment row are the record.

## Out of Scope

- Auto-pulling the bank balance from Plaid (FR-29, P2 — tracking true-up), un-reconciling in bulk.

## References

- [Source: docs/prd.md#FR-18] · [Source: docs/prd.md#UJ-8] · [Source: docs/prd.md#AS-5]
- [Source: docs/architecture.md#5-domain-model--budget-math]
