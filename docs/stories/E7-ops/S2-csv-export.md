# Story E7.S2: CSV export of register and budget

Status: done (dev complete 2026-06-12)

## Story

As Calvin, I want to export all transactions and the monthly budget to CSV on demand, so that my data is hostage-proof — usable in a spreadsheet or another tool even if this app dies (JTBD-4).

## Context

Two exports: (1) the full register — every transaction with account, date, payee, category, memo, amount, status, approval; (2) the monthly budget — assigned/activity/available per category per month. Served as REST endpoints (curl-able without the SPA) and as download buttons in the UI.

## Acceptance Criteria

- **AC-1** Given the register export, when downloaded, then its row count equals the register's transaction count (split lines represented so that re-totaling reproduces account balances exactly). *(FR-36)*
- **AC-2** Given the register CSV, when amounts are re-totaled externally per account (plus starting balances), then the results equal the app's displayed account balances to the cent. *(FR-36, FR-32)*
- **AC-3** Given the budget export, when downloaded, then it contains assigned, activity, and available per category per month for all months with data, matching the engine's values. *(FR-36)*
- **AC-4** Given the endpoints, when called with a valid session via curl, then CSV streams back without needing the SPA; without a session they return the auth challenge. *(FR-33, ADR-008)*
- **AC-5** Given CSV formatting, then amounts are decimal dollars with exact cent rendering from milliunits, dates ISO-8601, and fields properly quoted/escaped.

## Dev Notes

- Format milliunits → dollars at the edge only; never float arithmetic in totals. [ADR-004]
- REST/curl-ability is an explicit ADR-008 driver — keep endpoints stable and documented in the OpenAPI spec.
- Closed accounts and hidden categories are included (export = everything; FR-11 history preservation).

## Out of Scope

- Imports from this CSV format, scheduled exports, report-style aggregations (FR-37, P2).

## References

- [Source: docs/prd.md#FR-36] · [Source: docs/prd.md#JTBD-4]
- [Source: docs/architecture.md#7-api--auth]
- [Source: docs/adr/ADR-004] · [Source: docs/adr/ADR-008]

## Completion Notes (2026-06-12)

- `server/src/admin/export.ts` (admin module, ADR-001) — generator-based CSV
  builders; routes in `server/src/web/admin-routes.ts` stream them via
  `Readable.from` (nothing buffered). `GET /api/export/register.csv` and
  `GET /api/export/budget.csv`, behind the global session wall (AC-4 pinned by
  test: 401 challenge without a session, curl-able with one). Ops-screen
  download links.
- **Split representation (AC-1 interpretation):** one CSV row per ACCOUNTING
  LINE — split parents are omitted, their category lines exported (with the
  parent's payee and a `ParentId` column), the YNAB-register convention. This
  is the only shape that satisfies both halves of FR-36's Verified-by at once:
  re-totaling `Amount` per account reproduces every balance exactly (tested to
  the cent via `parseDollarsToMilliunits` re-totaling, integer math only) and
  the row count equals the register's money-bearing line count (split = its
  lines). Transfers export both sides with `TransferAccount` + derived
  "Transfer: X" payee; status/approved/source/is-starting-balance are columns;
  closed accounts and hidden categories included (FR-11).
- **Budget export (AC-3):** Month, Group, Category, Hidden, Carryover,
  Assigned, Activity, Available — every category × every month from first data
  through the current month, straight from the audited engine fold; tested
  cell-by-cell against `getBudgetMonth`.
- **AC-5:** amounts via the ONE audited formatter (`formatMilliunits`, exact
  cents, ADR-004 — admin/ is under the no-float lint), ISO dates from storage,
  RFC-4180 quoting (comma/quote/newline round-trip tested with a real parser).
- Tests: server/test/admin/export.test.ts (6) + ops API coverage in
  server/test/web/admin-api.test.ts. No OpenAPI spec file exists in this repo
  to extend (ADR-008's "documented" endpoints live in shared/src/api.ts types
  + README curl examples).
