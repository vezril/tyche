# Story E3.S5: RTA warning states and overspend styling

Status: done

## Story

As Calvin, I want unmistakable visual states for over-assigned RTA, unassigned money, and overspent categories, so that the zero-based target is always visible and never enforced by blocking me.

## Context

The system's stance is warn-don't-block: RTA may go negative (over-assigned) and category availables may go negative (overspent). This story adds the indicator semantics on top of the grid (E3.S2) and assignment editing (E3.S3).

## Acceptance Criteria

- **AC-1** Given assignments exceeding RTA, when committed, then the RTA indicator switches to a distinct negative/warning state showing the negative amount; the assignment is not blocked. *(FR-6)*
- **AC-2** Given RTA > $0 in the selected month, then the indicator shows a distinct "unassigned money" state prompting assignment (zero-based target visible). *(FR-6)*
- **AC-3** Given a transaction categorized beyond a category's available, when the grid renders, then the negative available displays in a distinct overspent style (e.g., the PRD's observed Groceries −$138.93 case) and entry was never blocked. *(FR-7)*
- **AC-4** Given an overspent category in the register and grid, then the styling is consistent across surfaces and meets the responsive ≥ 380 px layout. *(NFR-9)*
- **AC-5** Given RTA exactly $0, then the indicator shows the neutral/success "every dollar assigned" state.

## Dev Notes

- States are derived purely from engine values (E3.S1) — no stored flags. [ADR-005]
- Cash-overspend consequences at month boundary are engine behavior (E3.S1/AS-1); this story is presentation of the current month's negatives only.

## Out of Scope

- Credit-overspend variants (NG-3 — cash only), notifications/badges elsewhere in the app.

## References

- [Source: docs/prd.md#FR-6] · [Source: docs/prd.md#FR-7]
- [Source: docs/architecture.md#5-domain-model--budget-math]

## Completion Notes (2026-06-12)

- The RTA banner (`web/src/pages/BudgetPage.tsx` + `styles.css`) now has three
  explicit states derived purely from the engine's `rtaMilliunits` (no stored
  flags, per Dev Notes): **negative** → red `rta-banner negative`, amount +
  "Over-assigned — move money back" (AC-1); **positive** → amber
  `rta-banner positive`, amount + "Ready to Assign" prompting assignment
  (AC-2); **zero** → teal `rta-banner zero`, "$0.00 · Every dollar assigned"
  (AC-5). Warn-don't-block is asserted end to end: an over-assigning PUT is
  still issued and succeeds (server-side it always did — FR-6).
- AC-3: overspent availables keep the red `available-pill negative` style
  (E3.S2 groundwork); now also exercised by a dedicated S5 test and used
  inside the S4 popover's category picker, where availables are visible at
  the moment of covering an overspend (UJ-5).
- AC-4 (consistency + responsive): all negative-money surfaces share the same
  red (#dc322f — register balances, sidebar, pills, banner). NOTE the register
  itself has no per-category *available* display (outflow/inflow columns by
  design), so "overspent category in the register" reduces to the shared
  negative styling; the ≥ 380 px layout keeps the Available column visible
  (Activity folds away, per E3.S2 AC-5).
- No header count of overspent categories was added — the ACs don't ask for
  one; revisit as P2 polish if UJ-5 friction shows up.
- Tests: the E3.S5 describe in `web/test/budget-page.test.tsx` (5 — three
  banner states, over-assignment never blocked, overspent pill style).
