# Story E3.S3: Assign money via grid cell editing

Status: done

## Story

As Calvin, I want to edit a category's assigned amount directly in the month grid, so that payday assignment (UJ-2) is a fast keyboard loop that drives RTA to $0.

## Context

Assignment is the only stored budget input besides transactions: `(category, month) → assigned_milliunits`. Editing a cell persists on commit and the UI updates optimistically, reconciled against the server's recomputed numbers (the server always wins). Works for any month, past or future.

## Acceptance Criteria

- **AC-1** Given a category cell in the selected month, when Calvin edits the assigned value and commits (Enter/blur), then RTA and that category's available update in the same interaction, and the value survives a page reload. *(FR-4)*
- **AC-2** Given an edit, when committed, then the perceived UI update is < 200 ms (optimistic), and the server response carries the recomputed RTA/available that reconcile or correct the optimistic state. *(NFR-1, ADR-005, ADR-008)*
- **AC-3** Given keyboard-only use, when assigning across many categories, then Calvin can move cell-to-cell, type amounts, and commit without the mouse; a typical payday assignment is completable in ≤ 2 minutes. *(NFR-9)*
- **AC-4** Given a past or future month, when an assigned value is edited there, then it persists and all dependent months' carryover/RTA reflect it (recompute makes back-dated edits just work). *(FR-4, ADR-005)*
- **AC-5** Given an amount input, then it is parsed as whole cents to integer milliunits; unassigning (clearing to 0 or negative adjustments) is supported. *(FR-4, FR-32)*

## Dev Notes

- Persist as upsert on the MonthAssignment row; no aggregate maintenance exists by design. [ADR-005]
- Mutation response includes affected recomputed balances per ADR-008's contract.

## Out of Scope

- Move-money between categories (E3.S4 — paired adjustments), RTA warning styling (E3.S5), bulk assign / "assign last month's amounts" conveniences (P2).

## References

- [Source: docs/prd.md#FR-4] · [Source: docs/prd.md#NFR-1] · [Source: docs/prd.md#NFR-9] · [Source: docs/prd.md#UJ-2]
- [Source: docs/architecture.md#5-domain-model--budget-math] · [Source: docs/architecture.md#7-api--auth]
- [Source: docs/adr/ADR-005] · [Source: docs/adr/ADR-008]

## Completion Notes (2026-06-12)

- Editing lives in `web/src/pages/BudgetPage.tsx`: every assigned cell is a permanent
  `<input>` — click or Tab/ArrowUp/ArrowDown to reach it (focus selects the value), type a
  dollars amount, **Enter or blur commits, Escape cancels**. Empty input commits `"0"`
  (unassign); negative amounts pass through (`parseDollarsToMilliunits` is signed).
  Unchanged commits are no-ops (no API call). Invalid input → inline `role="alert"` error
  under the cell, no API call.
- Commit = optimistic integer-milliunit patch (`applyAssignment`: category available, group
  rollups, assigned-total, RTA all adjusted with +/- only, ADR-004) → `PUT
  /api/budget/:month/categories/:categoryId` → the server's full recomputed
  `BudgetMonthResponse` replaces local state (server always wins, ADR-005/008). A monotonic
  request token discards stale responses across rapid edits / month switches; on API error
  the month is refetched (authoritative rollback) and the error shows inline.
- AC-2 (< 200 ms perceived): the optimistic patch is synchronous state — same render cycle.
- AC-4 (any month): the PUT targets whatever month is on screen; cross-month carryover/RTA
  correctness is the engine's (E3.S1) and is asserted in `server/test/web/budget-api.test.ts`.
- Tests in `web/test/budget-page.test.tsx`: commit/PUT body + CSRF header, optimistic
  numbers before the response, server reconciliation (a deliberately different server RTA
  wins), reload survival via unmount + fresh mount against server state, Escape, blur
  commit, invalid + sub-cent rejection, unassign-to-zero, unchanged no-op, arrow-key moves.
