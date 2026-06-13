# Story E2.S3: Manual transaction entry with payee autocomplete

Status: ready-for-dev

## Story

As Calvin, I want to create, edit, and delete transactions by hand with fast keyboard entry and payee suggestions, so that cash spending and corrections keep the ledger true without waiting for the bank.

## Context

Manual entry is one of the four arrival paths (manual, Plaid, file, migration) and must produce identical budget effects to the others (FR-25). The payee list is built as a side effect of entry and powers autocomplete plus last-category suggestion. Requires accounts (E2.S1) and categories (E3.S6) to exist.

## Acceptance Criteria

- **AC-1** Given the register, when Calvin enters a transaction (date, payee, category, memo, outflow/inflow), then it appears in the register and adjusts the account balance, the category's activity/available, and RTA per its categorization. *(FR-14)*
- **AC-2** Given a future-dated entry, when saved, then it persists and is displayed; it participates in its own month's budget math. *(FR-14)*
- **AC-3** Given an existing transaction, when edited or deleted, then all derived balances reflect the change immediately (recompute-on-read — no stale aggregates possible). *(FR-14, NFR-12)*
- **AC-4** Given a new payee name typed once, when a later transaction's payee field receives a matching substring, then autocomplete offers the canonical payee. *(FR-19)*
- **AC-5** Given "Loblaws" was last categorized to Groceries, when a new "Loblaws" transaction is entered, then Groceries is pre-suggested as the category. *(FR-19)*
- **AC-6** Given the register, when entering a typical transaction, then the whole flow is completable keyboard-only (field-to-field tabbing, enter to commit), supporting the ≤ 2-minute daily-review bar. *(NFR-9)*
- **AC-7** Given a dollars-and-cents amount input, when parsed, then it is validated as whole cents and stored as integer milliunits; non-cent input is rejected. *(FR-32, ADR-004)*

## Dev Notes

- Manual entry creates approved transactions (approval state is for imported rows — FR-22).
- Mutations return the recomputed balances they affect so the client reconciles optimistic state in one round trip. [ADR-008, ADR-005]
- Categorizing to the system category *Inflow: Ready to Assign* is how income feeds RTA. [architecture §5]

## Out of Scope

- Splits (E2.S4), transfers (E2.S5), import matching against manual rows (E4.S3), payee management UI beyond autocomplete (no FR requires it).

## References

- [Source: docs/prd.md#FR-14] · [Source: docs/prd.md#FR-19] · [Source: docs/prd.md#FR-25] · [Source: docs/prd.md#NFR-9]
- [Source: docs/architecture.md#5-domain-model--budget-math]
- [Source: docs/adr/ADR-004] · [Source: docs/adr/ADR-005] · [Source: docs/adr/ADR-008]
