# ADR-005: Recompute budget aggregates on read — no stored aggregates

**Status:** Proposed (for Gate 2) · **Date:** 2026-06-12 · **Drivers:** NFR-12, FR-32 (C6) vs NFR-1, NFR-9 (C4); FR-1, FR-3, FR-8

## Context

Every screen shows derived numbers: per-category activity/available per month, group subtotals, account working/cleared balances, and RTA — which is cumulative across **all** months and entangled with the AS-1 overspend rule (a June overspend changes July's RTA). NFR-12 requires every displayed balance to be recomputable from raw rows, with a consistency check. The classic design tension: **stored/incrementally-maintained aggregates** (fast reads, drift risk) vs **recompute on read** (always correct, costs CPU per read). The data ceiling is small: ≥ 10k transactions, ≥ 40 categories, 60 months (NFR-1's own test envelope).

## Decision

**Recompute everything on read; store no aggregates.** The only persisted budget inputs are transactions (with split lines) and monthly assignments. A read executes: one indexed SQL `GROUP BY (category, month)` for activity, plus an in-memory fold across the ≤ 60 months applying carryover (`max(0, prev available)`) and the AS-1 RTA deductions. Month rollover (FR-8) is therefore **pure derivation — no rollover job, no month-close event, no stored carryover rows**. Account balances are `SUM()` over the account's rows. The NFR-12 consistency check remains as an independent re-implementation (in-memory walk vs SQL aggregation) run at boot, after migrations, and on demand.

**Escape hatch (named now, built never unless triggered):** if p95 month-grid reads exceed 250 ms server-side at real data volumes, add a per-(category, month) cache table treated strictly as a cache — invalidated by writes, rebuilt from scratch by the consistency check, never the source of truth.

## Consequences

**Positive:** a whole class of bugs is structurally impossible — there is no aggregate to forget to update on edit/delete/unmatch/migration-rerun, no drift between stored and true, no midnight rollover job to fail (the FR-8 month boundary cannot "not run"); NFR-12 is nearly free; FR-31's idempotent migration re-runs need no aggregate rebuild step; editing past months (FR-4 allows any month) just works.

**Negative:** every read pays the recompute — measured against the ceiling this is single-digit milliseconds in SQLite (10k-row indexed aggregation + a 60-step fold), leaving ~100× headroom under NFR-1's 1 s budget, but it must be verified by the seeded performance test before MVP exit; RTA's cumulative definition means one misplaced rule (e.g., future-month assignments) is wrong *everywhere* — concentrated in one function, property-tested against FR-1/3/8 invariants.

## Alternatives considered

- **Stored running aggregates, updated transactionally on write (YNAB-style server):** O(1) reads, but every mutation path (manual edit, split rewrite, transfer cascade, import merge, unmatch, migration re-run, category deletion with reassignment — FR-9) must maintain them perfectly; each is a drift bug waiting for a solo maintainer. The performance it buys isn't needed at this scale. Rejected.
- **Event sourcing / CQRS with projections:** maximal auditability, but a heavy paradigm tax (projections, replays, versioned events) for a CRUD-shaped single-user app; NFR-12's auditability is already satisfied by raw-row recompute. Rejected as over-engineering.
- **SQL-only derivation (recursive CTE for carryover/RTA):** keeps everything in one query but encodes the AS-1 fold in SQL where it's hardest to test; the hybrid (SQL aggregation + in-app fold) is more legible. Rejected.
