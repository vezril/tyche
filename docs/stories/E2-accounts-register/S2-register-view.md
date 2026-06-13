# Story E2.S2: Account register — list, sort, filter, search

Status: ready-for-dev

## Story

As Calvin, I want a per-account register listing every transaction with its key fields, searchable and filterable, so that I can find and audit any transaction quickly.

## Context

The register is the second-most-used surface after the month grid. It must stay fast at the 5-year ceiling (≥10k transactions), so rows are virtualized. This story is the read view; entry/editing is E2.S3. Approval status display exists from day one (imported rows arrive unapproved in E4), as does cleared status display.

## Acceptance Criteria

- **AC-1** Given an account with transactions, when its register is opened, then rows show date, payee, category, memo, outflow/inflow amount, cleared status, and approval status. *(FR-13)*
- **AC-2** Given a payee-substring search, when executed, then exactly the matching transactions in that account are returned. *(FR-13)*
- **AC-3** Given filters for date range, payee, and category, when applied (individually or combined), then the row set and the displayed filtered totals match the filter. *(FR-13)*
- **AC-4** Given a register with the latest 100 rows of a 10k-transaction seeded dataset, when opened, then usable render is reached in < 1 s (p95 over 20 loads, desktop over LAN). *(NFR-1)*
- **AC-5** Given a phone-sized viewport (≥ 380 px), when the register is used, then rows and the review workflow remain usable (responsive layout, no horizontal scroll for core fields). *(NFR-9)*
- **AC-6** Given column sort (at minimum by date), when toggled, then ordering is applied within the current filter.

## Dev Notes

- Virtualize rows with TanStack Virtual; server pagination/windowing acceptable but the < 1 s target is for the latest-100 view. [ADR-002, NFR-1]
- Server state via TanStack Query. Amounts formatted from milliunits only at the UI edge. [ADR-004, ADR-008]
- Unapproved rows must be *visibly distinct* (style decided here, used by E4.S2). [FR-22]

## Out of Scope

- Creating/editing transactions (E2.S3), approving (E4.S2), reconciliation (E2.S7), cross-account "all accounts" view (not required by any FR).

## References

- [Source: docs/prd.md#FR-13] · [Source: docs/prd.md#NFR-1] · [Source: docs/prd.md#NFR-9]
- [Source: docs/architecture.md#7-api--auth]
- [Source: docs/adr/ADR-002] · [Source: docs/adr/ADR-008]
