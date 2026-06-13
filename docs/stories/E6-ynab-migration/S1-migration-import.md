# Story E6.S1: YNAB migration — structure and full transaction history

Status: done

## Story

As Calvin, I want my entire YNAB budget — accounts, category groups/categories, payees, and full multi-year transaction history including splits and transfers — imported into the app, so that I start with my real budget, not a blank one (UJ-1).

## Context

The migration backend of the importer port. Source: YNAB's standard export format and/or an API pull while the subscription is live (AS-4); full history depth was confirmed at the gate (OQ-5). YNAB stores amounts as milliunits natively, so amounts copy losslessly — zero conversion (risk R3 mitigation). Migrated transactions skip the review queue (approval pre-set) but flow through the same pipeline for provenance. Per-month assignments and parity verification are E6.S2.

## Acceptance Criteria

- **AC-1** Given a YNAB export (and/or API pull), when migration runs against an empty budget, then all accounts (with on-budget/tracking type and starting balances), category groups/categories (with order and hidden flags), and payees are created. *(FR-30)*
- **AC-2** Given the transaction history, when imported, then every transaction lands in the right account with date, payee, category, memo, milliunit amount (lossless copy — no arithmetic on amounts), and cleared/reconciled status preserved. *(FR-30, FR-32, ADR-004)*
- **AC-3** Given YNAB split transactions, then they import as parent + lines summing exactly to the total; given YNAB transfers, then they import as paired linked rows, not two orphans. *(FR-30, FR-15, FR-16)*
- **AC-4** Given migrated rows, then they are marked `source: migration`, arrive approved, and produce identical budget effects to any other source. *(FR-25, FR-22)*
- **AC-5** Given each account after migration, then its working balance matches YNAB's value for that account on migration day, to the cent. *(FR-30)*
- **AC-6** Given source rows that cannot be mapped (unknown category, malformed row), then they are written to a discrepancy report — never silently dropped. *(FR-31)*

## Dev Notes

- Backend of the importer port — emits the shared staged shape with approval pre-set; ledger writes go through the same command layer as the UI. [ADR-006, architecture §6]
- YNAB category names colliding with system categories (*Inflow: Ready to Assign*) map onto them, not duplicates.
- Run before real Plaid linking in production cutover so heuristic matching (E4.S3) can pair any overlap.

## Out of Scope

- Per-month assigned amounts, idempotency guarantee, and the full parity check (E6.S2); migrating YNAB goals/scheduled transactions (FR-38/39, P2); past RTA snapshot reproduction (AS-4 allows reconstruction).

## References

- [Source: docs/prd.md#FR-30] · [Source: docs/prd.md#AS-4] · [Source: docs/prd.md#OQ-5] · [Source: docs/prd.md#UJ-1]
- [Source: docs/architecture.md#6-import-subsystem] · [Source: docs/architecture.md#9-risk-storm]
- [Source: docs/adr/ADR-004] · [Source: docs/adr/ADR-006]

## Completion Notes (2026-06-12)

- **Module placement:** `server/src/migration/` — a SIBLING of `importing/`, not inside it,
  because the migration must also write month assignments through the budget module and the
  ADR-001 lint boundary forbids `importing → budget` (FR-25). The boundary matrix gained a
  `migration` row (may use ledger/budget/db/crypto; never importing/auth/admin/web; nothing
  imports migration) and the ADR-004 money lint covers the new module; both pinned in
  `server/test/lint/boundaries.test.ts`. All ledger writes go through `ledger/index.ts`
  commands (`createAccount`/`createTransaction`/`updateTransaction`/`setImportIdentity`), so
  budget effects are arrival-path identical (AC-4); rows arrive `source: 'migration'`,
  `approved = 1`, with a per-account `import_batches` provenance row (no new SQL migration —
  schema 0007 already admits 'migration').
- **Source format** (AS-4): YNAB's export pair as one multipart `POST /api/migration`
  (fields `register` + `plan`; multipart `files` limit raised 1→2 in app.ts). Parsers in
  `migration/parse.ts` are tolerant: separate "Category Group"/"Category" columns OR the
  combined "Category Group/Category" (split on first ': ' — which is why "Inflow: Ready to
  Assign" also arrives as group "Inflow"/category "Ready to Assign"; both spellings map to
  the seeded system category). Amounts are locale-formatted strings ("C$1,234.56", "$45.00",
  "(45.00)", unicode minus, plain "1234.56") parsed string→milliunits via the one audited
  parser — no floats anywhere (FR-32, ADR-004). Malformed rows become `{line, reason}`
  discrepancy entries; only a structurally-wrong file (missing columns) is refused outright.
- **Reconstruction decisions** (each tolerant path writes a discrepancy entry — AC-6):
  account on-budget/tracking is INFERRED (≥1 categorized row = on-budget; none = tracking,
  reported — the export carries no type column); the earliest "Starting Balance" register row
  per account becomes the account's real starting-balance transaction (status restored after
  `createAccount`, no duplicate row); transfers re-link paired "Transfer : X" rows by
  (date, account pair, ±amount) into one `transfer_id` with per-side status/memo, mixed pairs
  categorized on the on-budget side (AC-3) — an unpaired row imports as a plain transaction +
  report; splits reconstruct from the old "(Split n/m)" memo convention on consecutive rows
  sharing account/date/payee, summing exactly (FR-15) — incomplete/ambiguous groups (and the
  marker-less new convention) import as separate rows + report, never guessed; "Uncategorized"
  → NULL category + per-row report; flags have no equivalent → dropped + report.
- **Verified-by (FR-30/AC-5):** fixture pair under `server/test/migration/fixtures/` modeled
  on docs/analysis/ynab-usage.md (5 accounts incl. tracking TFSA, 10 groups / 30 categories
  incl. "Hidden Categories", 4 months, splits, on↔on + on↔tracking transfers, May Groceries
  overspent −$138.93, locale-formatted amounts, malformed/flagged/uncategorized rows). All
  five account working balances assert to the cent against hand-computed sums AND via the
  parity report (e.g. TFSA $13,095.67).
- Verification: lint + typecheck clean; full suite 17 shared + 462 server + 67 web = 546
  green (was 484); build clean. Tests: `server/test/migration/{parse,migrate}.test.ts`,
  `server/test/web/migration-api.test.ts`, `web/test/migration-page.test.tsx`.
