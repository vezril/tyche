# Story E3.S1: Budget computation engine (activity, available, carryover, RTA)

Status: ready-for-dev

## Story

As Calvin, I want every budget number — per-category activity, available, carryover, and Ready to Assign — computed exactly and consistently from raw transactions and assignments, so that I can trust the displayed numbers to the cent (JTBD-2).

## Context

This is the money-math heart and the highest-correctness story (risk R4). The architecture fixes the formulas and the approach: **recompute on read, store no aggregates**. Persisted inputs are only transaction lines and `(category, month) → assigned` rows. Month rollover is pure derivation — there is no rollover job. This story delivers the engine plus the month-data API the grid (E3.S2) consumes; it has no UI of its own beyond what's needed to verify via API.

## Acceptance Criteria

- **AC-1** Given a category with $50 carryover, $200 assigned, and −$120 activity in a month, then `available = 130_000` milliunits (`available = carryover + assigned + activity`). *(FR-1)*
- **AC-2** Given a $1,000 inflow categorized to *Inflow: Ready to Assign*, then RTA for that month rises by exactly $1,000; assigning $1,000 across categories returns RTA to its prior value. *(FR-3)*
- **AC-3** Given a category ending June at −$40 (cash overspend), then its July carryover is $0 and July's RTA is exactly $40 lower than it would otherwise be; a category ending June at +$40 carries $40 into July. *(FR-8, AS-1)*
- **AC-4** Given tracking-account transactions, then they never appear in `activity` and never affect RTA. *(FR-10)*
- **AC-5** Given assignments in future months, then RTA for month *m* subtracts assigned across **all months ≤ m** plus cumulative overspend deductions ≤ m. *(FR-3)*
- **AC-6** Given property-based tests over random transaction/assignment sets, then invariants hold: ΣRTA changes + Σavailable changes reconcile with inflows/outflows; recompute is deterministic; all arithmetic is integer milliunits. *(FR-32, NFR-12, ADR-004)*
- **AC-7** Given the seeded ceiling dataset (10k transactions, 40 categories, 60 months), then a full month recompute completes server-side well within the NFR-1 budget (target: p95 < 250 ms server-side, the ADR-005 escape-hatch trigger). *(NFR-1)*

## Dev Notes

- Implementation shape is decided: one indexed SQL `GROUP BY (category, month)` for activity + an in-memory fold over ≤ 60 months applying `carryover = max(0, prev available)` and AS-1 RTA deductions. Concentrate the fold in one audited function. [ADR-005, architecture §5]
- `activity` sums *transaction lines* (split children), approved or not, on-budget accounts only.
- The budget module must not see transaction `source` — enforce via module boundary lint. *(FR-25, ADR-001)*

## Out of Scope

- Grid UI (E3.S2), assignment editing (E3.S3), the user-facing consistency check (E7.S4 — but write the independent in-memory recompute testably so E7.S4 can expose it).

## References

- [Source: docs/prd.md#FR-1] · [Source: docs/prd.md#FR-3] · [Source: docs/prd.md#FR-8] · [Source: docs/prd.md#AS-1] · [Source: docs/prd.md#NFR-12]
- [Source: docs/architecture.md#5-domain-model--budget-math]
- [Source: docs/adr/ADR-004] · [Source: docs/adr/ADR-005]
