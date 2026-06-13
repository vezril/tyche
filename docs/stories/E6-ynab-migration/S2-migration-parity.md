# Story E6.S2: Migration assignments, idempotency, and parity report

Status: done

## Story

As Calvin, I want my per-month assigned amounts migrated and an automated proof that the migrated budget matches YNAB to the cent, so that I can trust the cutover and re-run it safely until it's right.

## Context

Completes FR-30/31 on top of E6.S1: import `(category, month) → assigned` for all budget months, make the whole migration idempotent / safely re-runnable into an empty budget, and produce the machine-checked parity + discrepancy report. This is the gate for starting the SM-1 parallel-run month. Note AS-1: the app derives carryover/RTA itself, so historical YNAB months may show reconstructed (not verbatim) RTA — parity is asserted on **migration-day** state per FR-30.

## Acceptance Criteria

- **AC-1** Given the YNAB source, when migration runs, then every month's assigned amount per category is imported as MonthAssignment rows (lossless milliunits). *(FR-30)*
- **AC-2** Given a completed migration, then each category's **current-month available** and each account's working balance match YNAB's migration-day values to the cent, verified by an automated comparison the migration outputs (pass/fail per category and account). *(FR-30)*
- **AC-3** Given two migration runs from scratch (empty budget each time) with the same source, then the resulting data is identical (row-for-row equivalent). *(FR-31)*
- **AC-4** Given a re-run attempted against a non-empty budget, then the migration either safely no-ops per already-imported entity (idempotent keys) or refuses with a clear message — it never duplicates or half-applies. *(FR-31)*
- **AC-5** Given any unmappable or unverifiable item, then it appears in the human-readable discrepancy report with source reference and reason; the report is shown/persisted at completion. *(FR-31)*
- **AC-6** Given the migrated dataset, then the NFR-12 consistency check passes on it. *(NFR-12)*

## Dev Notes

- Recompute-on-read means re-runs need no aggregate rebuild — idempotency is purely about input rows. [ADR-005]
- Where YNAB's derived history can't be reproduced verbatim (e.g., past RTA snapshots), reconstruct from raw data per AS-4 and note it in the report rather than failing parity.
- The SM-1 parallel run (one month, numbers agree within $0.01) is the release gate downstream of this story — make the comparison output reusable for that.

## Out of Scope

- The parallel-run process itself (operational, not code), migrating into a budget with pre-existing manual data (migration targets an empty budget by design).

## References

- [Source: docs/prd.md#FR-30] · [Source: docs/prd.md#FR-31] · [Source: docs/prd.md#AS-4] · [Source: docs/prd.md#SM-1]
- [Source: docs/architecture.md#6-import-subsystem] · [Source: docs/architecture.md#9-risk-storm]
- [Source: docs/adr/ADR-004] · [Source: docs/adr/ADR-005]

## Completion Notes (2026-06-12)

- **AC-1 assignments:** the Plan CSV's per-(month, category) Budgeted imports through
  `budget.setAssignedAmount` (lossless milliunits; months parse from "Jun 2026" / "2026-06" /
  ISO-date forms). Zero amounts are skipped — the app's no-zero-row invariant — and Budgeted
  on Inflow/Uncategorized is skipped + reported. Fixture: 115 nonzero MonthAssignment rows
  across 2026-03..06, asserted row-exactly.
- **AC-2 parity proof:** `buildParityReport` in `server/src/migration/migrate.ts`, returned
  in the `MigrationResponse` payload and rendered on the Migration screen — per-account
  (source = Σ parsed register amounts, computed straight from the SOURCE rows; imported =
  recomputed working balance) and per-category for the migration-day month (= latest Plan
  month; source = the Plan CSV's own Available; computed = the audited `computeBudget` fold
  via the newly-exported `loadEngineInputs`, NOT the grid read model, so hidden categories
  are covered). Pass/fail per row + overall `ok`. Fixture passes 5/5 accounts and 30/30
  categories to the cent, including the overspent-Groceries month (May −$138.93 → June
  carryover 0 per AS-1, matching YNAB's own rule). RTA is intentionally NOT asserted (AS-4:
  reconstructed, not verbatim). The report shape is reusable as the SM-1 comparison.
- **AC-3 determinism:** rows are processed in source order; two runs from scratch are
  asserted row-for-row equivalent via a canonical dump (ids/timestamps normalized away,
  insertion order preserved) in `server/test/migration/migrate.test.ts`.
- **AC-4 refusal:** migration targets an EMPTY budget only — `assertEmptyBudget` refuses
  with `budget_not_empty` (HTTP 409) + per-table counts when ANY non-seed accounts /
  transactions / payees / non-system categories or groups / assignments exist; all writes
  run inside one SQLite transaction, so nothing can half-apply. Tested: re-run refused with
  the DB byte-equivalent before/after; refusal also fires on structure-only residue.
- **AC-5 discrepancy report:** every tolerant path (malformed row, unknown Cleared value,
  ambiguous split, unpaired transfer, dropped flag, uncategorized row, tracking-type
  inference, unmappable plan category) lands in `discrepancies[{source, line, reason}]`,
  shown on the Migration page at completion. Nothing is silently dropped — pinned by test.
- **AC-6:** `runConsistencyCheck` (NFR-12) runs on the migrated dataset as part of the
  migration and is returned/displayed; fixture passes with zero mismatches.
- **For E7 (ops):** the migration adds NO new tables (report is response-payload only, per
  story latitude) — backup/restore (E7.S1) needs no migration-specific handling beyond
  `import_batches` rows already covered; CSV export (E7.S2) will see `source='migration'`
  rows and per-side transfer statuses; the consistency check surface (E7.S4) can reuse
  `runConsistencyCheck` exactly as the migration does, and the parity-report shape
  (`MigrationParityReport` in shared/src/api.ts) is the ready-made format for the SM-1
  parallel-run comparison. Production cutover order still matters: run migration BEFORE
  linking Plaid (E4.S3 heuristics then pair any overlap).
