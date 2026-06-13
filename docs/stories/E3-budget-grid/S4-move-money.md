# Story E3.S4: Move money between categories

Status: done

## Story

As Calvin, I want to move available money from one category to another within a month, so that covering an overspend (UJ-5) is one quick action instead of two manual assignment edits.

## Context

A move is recorded as **paired assignment adjustments** in the same month: source assigned −X, destination assigned +X. RTA is untouched by construction. This is the standard YNAB "cover overspending" gesture.

## Acceptance Criteria

- **AC-1** Given Category A with available ≥ $50, when Calvin moves $50 from A to B, then A's available decreases by $50, B's increases by $50, and RTA is unchanged. *(FR-5)*
- **AC-2** Given the move dialog, when opened from a category (typically an overspent one), then it offers direction (to/from), amount, and a category picker with current availables visible; committing persists both adjustments atomically (one DB transaction). *(FR-5)*
- **AC-3** Given a move that would drive the source negative, then it is warned about but not blocked (overspending is permitted). *(FR-7, FR-6)*
- **AC-4** Given a committed move, when the page reloads, then both categories' assigned values reflect the paired adjustment. *(FR-5)*
- **AC-5** Given the flow, then it is keyboard-operable end to end. *(NFR-9)*

## Dev Notes

- Implementation = two MonthAssignment deltas in one SQLite transaction; no new entity. [architecture §5]
- Moving to/from RTA itself is just a single assignment edit (E3.S3) — do not build a special case here.

## Out of Scope

- Cross-month moves (no FR), auto-cover suggestions (P2).

## References

- [Source: docs/prd.md#FR-5] · [Source: docs/prd.md#UJ-5]
- [Source: docs/architecture.md#5-domain-model--budget-math]
- [Source: docs/adr/ADR-005]

## Completion Notes (2026-06-12)

- **Representation (per Dev Notes):** `POST /api/budget/:month/move`
  (`MoveMoneyRequest { fromCategoryId, toCategoryId, amount }`) →
  `moveMoney()` in `server/src/budget/assignments.ts` performs the two
  `setAssignedAmount` deltas in ONE `db.transaction` (AC-2 atomicity: a bad
  destination rolls back the source write). No new entity, no engine change —
  the RTA formula (AS-1) is untouched; the paired deltas cancel by
  construction (AC-1). Responds with the full recomputed
  `BudgetMonthResponse`, same contract as the assignment PUT.
- Amount must be strictly positive (`move_amount_not_positive`, 400);
  from ≠ to (`move_requires_two_categories`, 400); moves to/from
  *Inflow: Ready to Assign* are rejected (per Dev Notes that is a single
  E3.S3 assignment edit, not a move). Driving the source negative is
  **permitted** (AC-3, FR-7) — the warning is client-side only.
- UI (`web/src/pages/BudgetPage.tsx`): every category row's available pill is
  now a real `<button>` (keyboard-operable, AC-5) opening an inline popover —
  direction (to/from this category), amount, and a picker of the other
  categories **with their current availables** (AC-2). Commit = optimistic
  `applyMove` (two `applyAssignment` patches, RTA deltas cancel) → POST →
  server reconciliation via the existing request-token pattern; Escape/Cancel
  close without a call; a live `role="status"` warning names the overspend
  amount when the move would drive its source negative (AC-3).
- Tests: `server/test/web/move-money-api.test.ts` (8 — pairing, atomicity,
  reload survival incl. zero-row cleanup, cross-month carryover, validation,
  auth/CSRF) and the E3.S4 describe in `web/test/budget-page.test.tsx` (5 —
  POST body/CSRF, optimistic paired update with RTA pinned, direction swap,
  warn-not-block, keyboard/Escape).
