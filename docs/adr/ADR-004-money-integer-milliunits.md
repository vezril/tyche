# ADR-004: Money as integer milliunits (CAD)

**Status:** Proposed (for Gate 2) · **Date:** 2026-06-12 · **Drivers:** FR-32, NFR-12 (C6); FR-30 (migration fidelity)

## Context

FR-32 forbids binary floating-point money. The system is permanently single-currency CAD (NG-2). The migration source — YNAB — stores all amounts as **milliunits** (1/1000 of a dollar, per `ynab-usage.md`), and FR-30 demands to-the-cent reproduction of every balance. JavaScript (ADR-002) has no native decimal type; its `number` is an IEEE-754 double — exact for integers up to 2^53, lossy for decimal fractions.

## Decision

Store and compute **all monetary amounts as signed integers in milliunits** (`-138930` = −$138.93), in `INTEGER` columns and in application arithmetic. Format to dollars/cents only at the UI edge; parse user input (dollars) to milliunits at the API boundary with validation that inputs are whole cents. Branded TypeScript type (`Milliunits`) so amounts don't mix with ordinary numbers; lint/code-review rule: no `*`/`/` on money outside a small audited utilities module (splits, adjustments), where any division must produce integer parts that sum exactly to the whole (largest-remainder allocation).

## Consequences

**Positive:** all additions/subtractions — which is nearly all budget math (FR-1, FR-3, FR-8) — are exact by construction; YNAB migration is a **lossless copy** of amounts, eliminating an entire fidelity risk (R3); sums of a lifetime of transactions (~10^9 milliunits) sit ten orders of magnitude under the 2^53 exactness bound; NFR-12's recompute checks compare integers — no epsilon comparisons anywhere.

**Negative:** a unit-confusion bug (treating milliunits as cents or dollars) is possible — mitigated by the branded type and by round-trip property tests; rendering/parsing logic concentrates at the edges and must be tested for sign/rounding display conventions; third-party data must be converted on ingest (Plaid sends decimal-string/float dollar amounts — parsed via string, never via float arithmetic; OFX/CSV likewise).

## Alternatives considered

- **Integer cents:** equally exact and simpler-looking, but every YNAB migration value would divide by 10 — pure conversion risk for zero benefit, and a future data source with sub-cent precision would force a schema change. Rejected: milliunits cost nothing extra and match the source of truth.
- **Decimal library (`decimal.js`/`big.js`) over TEXT columns:** exact, but every arithmetic site depends on library discipline, DB-level `SUM()` becomes unusable (TEXT), and performance/SQL ergonomics suffer. Rejected.
- **SQLite REAL / JS number of dollars:** violates FR-32 outright. Rejected.
