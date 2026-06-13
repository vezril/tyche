# Story E7.S4: Built-in money-math consistency check

Status: done (dev complete 2026-06-12)

## Story

As Calvin, I want a built-in check that re-derives every displayed balance from raw rows and compares it against an independent recomputation, so that I have standing proof the money math hasn't drifted (NFR-12).

## Context

Because aggregates are never stored (ADR-005), the check is a cross-verification of the two derivation paths: the SQL aggregation used by reads vs an independent in-memory walk over raw transaction lines and assignments (built testably in E3.S1). It runs at boot, after migrations (both schema and YNAB data migration), and on demand from the admin screen.

## Acceptance Criteria

- **AC-1** Given the seeded/migrated dataset, when the consistency check runs, then it recomputes every account working/cleared balance, every (category, month) activity/available, and every month's RTA via the independent path and reports zero mismatches. *(NFR-12)*
- **AC-2** Given boot and post-migration hooks, then the check runs automatically at both, logging a summary; a mismatch is surfaced loudly (boot warning state + admin banner), never silently. *(NFR-12, NFR-11)*
- **AC-3** Given the admin/settings screen, when Calvin triggers the check on demand, then results (pass, or per-entity mismatch list with both values) display within the request. *(NFR-12)*
- **AC-4** Given integer milliunits everywhere, then comparisons are exact equality — no epsilon. *(FR-32, ADR-004)*
- **AC-5** Given an artificially corrupted value in a test (e.g., a tampered split line), then the check detects and pinpoints the affected entity. *(NFR-12)*

## Dev Notes

- This is the NFR-12 verification mechanism named in ADR-005 — an independent re-implementation, not a second call into the same engine function. Keep the two paths honestly separate.
- Lives in the `admin/` module per the architecture's module map.
- Cheap at the data ceiling (single-digit ms aggregations); no need for background scheduling.

## Out of Scope

- Auto-repair of mismatches (report only), checksum history/trending, the migration balance-checksum bracket (E7.S3 — related but distinct mechanism).

## References

- [Source: docs/prd.md#NFR-12] · [Source: docs/prd.md#FR-32]
- [Source: docs/architecture.md#2-architecture-style] · [Source: docs/architecture.md#5-domain-model--budget-math]
- [Source: docs/adr/ADR-004] · [Source: docs/adr/ADR-005]

## Completion Notes (2026-06-12)

- **Reused and extended** `server/src/budget/consistency.ts`
  `runConsistencyCheck` (exactly as E6.S2 anticipated — the migration's call
  site is unchanged and still green). The report now also covers (AC-1):
  every account's working/cleared balance (path A = the serving SQL SUM shape
  from ledger/accounts.ts; path B = an in-memory walk over individual rows,
  no SQL aggregation), plus every (category, month) and every month's RTA via
  the existing dual-path budget fold. Added coverage counters
  (`checkedAccounts`/`checkedMonths`) so a pass proves it walked something.
- **Raw-row invariants (AC-5):** the two aggregation paths read the same rows,
  so a tampered SPLIT LINE is invisible to both — the check therefore also
  verifies FR-15 (split children sum exactly to the parent's total) and FR-16
  (a transfer id names exactly two rows whose amounts cancel), pinpointing the
  parent/transfer id with both values. Tested: tampered split line (named with
  `-95000 vs parent total -90000`), tampered transfer side, single-milliunit
  drift (AC-4 exact equality — no epsilon anywhere), and the E5.S5 contract
  that a blanked UNLINKED token is NOT flagged.
- **Boot + post-migration (AC-2):** runs inside `runStartupSequence`
  (web/boot.ts) after schema migrations — pass logs a summary, failure logs
  loudly AND surfaces as a red `role=alert` banner on the Ops screen via
  `GET /api/admin/consistency` (boot report); deliberately a warning state,
  not a refusal to start (the user must be able to see the report). The YNAB
  data migration kept its own post-run call (E6.S2 AC-6).
- **On demand (AC-3):** `POST /api/admin/consistency/run` returns
  pass/mismatch-list within the request (single-digit ms at the data ceiling,
  per the E3 perf test); Ops screen button renders the per-entity list; also
  `ynab-clone check` (non-zero exit on mismatch) for drills/cron.
- Tests: server/test/budget/consistency.test.ts (extended, 8),
  server/test/web/boot.test.ts, server/test/web/admin-api.test.ts,
  web/test/ops-page.test.tsx.
