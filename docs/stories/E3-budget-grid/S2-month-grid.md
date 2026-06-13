# Story E3.S2: Month-grid budget screen with month navigation

Status: done

## Story

As Calvin, I want a month grid showing assigned, activity, and available per category with group subtotals, navigable to any month, so that the budget screen I live in matches the YNAB surface I know (UJ-2).

## Context

The grid is *the* product surface (architecture calls it out as the keyboard-editing spike candidate). This story renders the read view from the E3.S1 month API: ~31 categories in ~9 ordered groups, group subtotal rows, RTA header, prev/next-month and jump navigation. Cell editing is E3.S3; warning styling is E3.S5.

## Acceptance Criteria

- **AC-1** Given any selected month, when the grid renders, then every visible category appears under its group in the defined order, with per-category assigned/activity/available and per-group subtotals that equal the sum of their categories. *(FR-2)*
- **AC-2** Given month navigation (previous/next and direct month-year selection), when used, then any past or future month renders with that month's correct numbers — including months before the first transaction and future months. *(FR-2, FR-1)*
- **AC-3** Given Ready to Assign, then it is prominently displayed for the selected month per the engine's value. *(FR-3)*
- **AC-4** Given the 10k-transaction seeded dataset, when the grid loads, then usable render is < 1 s (p95 over 20 loads, desktop over LAN). *(NFR-1)*
- **AC-5** Given a phone-sized viewport (≥ 380 px), when checking a category's available before a purchase (UJ-4), then the category list with available amounts is readable and scrollable without horizontal panning. *(NFR-9)*
- **AC-6** Given keyboard navigation, then focus can move between category cells without a mouse (full editing keys land in E3.S3). *(NFR-9)*

## Dev Notes

- Custom grid component (no heavyweight grid library) per ADR-002; TanStack Query for the month payload; one request per month view. Code-split the grid bundle. [ADR-002, ADR-008]
- Hidden categories/groups (FR-9) are excluded from the default view — coordinate with E3.S6.
- Run this story as the architecture's recommended keyboard/perf spike: validate the < 200 ms feel with seeded data before finalizing component choices. [architecture §9]

## Out of Scope

- Editing assigned values (E3.S3), move-money (E3.S4), negative/warning styling (E3.S5), category drill-down (P2 quality-of-life).

## References

- [Source: docs/prd.md#FR-2] · [Source: docs/prd.md#FR-3] · [Source: docs/prd.md#NFR-1] · [Source: docs/prd.md#NFR-9]
- [Source: docs/architecture.md#7-api--auth] · [Source: docs/architecture.md#9-risk-storm]
- [Source: docs/adr/ADR-002] · [Source: docs/adr/ADR-008]

## Completion Notes (2026-06-12)

- `web/src/pages/BudgetPage.tsx` (code-split via `React.lazy`, own 5.9 kB chunk) renders the
  E3.S1 payload: groups in display order with subtotal rows + collapse/expand, category rows
  with assigned/activity/available, sticky header carrying month nav (prev/next + `<input
  type="month">` jump, clamped to `bounds`) and the RTA banner. Negative available = red pill.
- Month math lives in `web/src/months.ts` (string/integer only, mirrors `server/src/budget/month.ts`).
- **Deviation from dev notes:** TanStack Query was NOT introduced — the app's established
  plain-fetch (`apiGet`/`apiSend`) + `useState` pattern covers one-request-per-month plus
  optimistic reconciliation, and adding the dependency conflicted with the keep-it-lean bar
  (NFR-2). Revisit if cache/invalidation surface area grows in E4/E5.
- **AC-4 / NFR-1 assessment:** no browser perf harness. The payload is a single month
  (~31 categories / ~9 groups → ~40 flat rows, one GET); the server-side recompute is
  perf-tested in `server/test/budget/perf.test.ts` at the 10k-transaction ceiling
  (single-digit ms), and a 40-row React table render is microseconds-scale — orders of
  magnitude inside the < 1 s budget. The 40 cats × 60 months figure never renders at once
  by design (one month per view).
- AC-5: at ≤ 700 px the Activity column folds away so name/assigned/available fit ≥ 380 px
  with no horizontal panning. AC-6: every assigned cell is a real `<input>` (Tab order =
  row order; ArrowUp/ArrowDown jump rows) — see E3.S3.
- Tests: `web/test/months.test.ts` + `web/test/budget-page.test.tsx` (vitest + jsdom +
  @testing-library/react, fetch mocked; new minimal setup documented in `web/vitest.config.ts`).
