# Story E3.S6: Category and group management

Status: done

## Story

As Calvin, I want to create, rename, reorder, hide, and delete categories and category groups, so that the budget structure mirrors my real ~31 categories in ~9 groups and can evolve safely.

## Context

Categories/groups are ordered and hidable. Deleting a category that has transaction or assignment history is destructive to budget math, so it requires reassigning history to another category first. Two system categories (*Inflow: Ready to Assign*, *Reconciliation adjustment*) exist and are protected. This story should land **early** (right after accounts) because transactions and the grid both need categories.

## Acceptance Criteria

- **AC-1** Given the budget structure screen, when Calvin creates/renames categories and groups, then changes appear in the grid and in transaction category pickers immediately. *(FR-9)*
- **AC-2** Given drag (or keyboard) reordering of categories within and across groups, and of groups themselves, then the new order persists and the grid renders it. *(FR-9)*
- **AC-3** Given a hidden category or group, then it disappears from the default grid and pickers but its history remains in all math and can be unhidden. *(FR-9)*
- **AC-4** Given a category with transactions (or assignments), when deletion is attempted, then the app requires choosing a target category; afterwards all its transactions report the target category and the source is gone — and recomputed balances reflect the reassignment. *(FR-9, NFR-12)*
- **AC-5** Given a category with no history, when deleted, then it is removed without prompting for a target. *(FR-9)*
- **AC-6** Given system categories, then they cannot be renamed into collision, hidden, or deleted.

## Dev Notes

- The AC-6 protection rule applies to the seeded pair of system categories from E1.S1 (*Inflow: Ready to Assign*, *Reconciliation adjustment*) — this story enforces the rule, it does not create them.
- Reassign-then-delete must run in one DB transaction. Assignments for the deleted category: move/merge into the target per month (sum if both exist).
- Order via an integer `sort_order` (or equivalent); groups own ordered categories. [architecture §5]

## Out of Scope

- Category targets/goals (FR-39, P2), bulk recategorization tools beyond delete-reassign, group deletion with categories inside (require empty or move categories first — keep it simple).

## References

- [Source: docs/prd.md#FR-9]
- [Source: docs/architecture.md#5-domain-model--budget-math]
- [Source: docs/adr/ADR-005]

## Completion Notes (2026-06-12)

- **No migration needed**: `sort_order`/`hidden`/`is_system` existed since
  0001; next migration number stays **0007**.
- Server: domain in `server/src/budget/categories.ts`, HTTP in
  `server/src/web/category-routes.ts`. `GET /api/categories/structure`
  (management view: hidden rows included, **system group excluded** — it is
  not manageable by design); `POST/PATCH/DELETE /api/category-groups[/:id]`
  and `/api/categories[/:id]`. PATCH carries `name` / `hidden` / `groupId` /
  `index` — rename, hide/unhide, and reorder within & across groups in one
  verb; group PATCH takes `index` for group reordering. Every mutation
  returns the full recomputed structure (one-round-trip reconcile, the grid
  contract reused). Order = dense renumbered `sort_order` per sibling list.
- **Delete-with-history (AC-4) decisions:** history = transaction rows
  (split LINES included — they live in the same table, so one `UPDATE …
  category_id` covers them) OR `month_assignments` rows. Assignments are
  **merged into the target per month (summed when both months exist)** per
  the Dev Notes — totals/RTA provably unchanged; resulting $0 rows are
  removed (no-zero-residue invariant). `payees.last_category_id` follows the
  target (FK stays valid). All in ONE SQLite transaction (NFR-12). Without a
  target: 409 `reassignment_required`. Target must exist, ≠ source, ≠ the
  inflow category (400 `invalid_reassignment_target`; *Reconciliation
  adjustment* IS a legal target — it already takes real activity).
- **AC-6:** rename/hide/delete/move of `is_system` rows (and the System
  group, including creating/moving categories into it) → 403
  `system_protected`; system category NAMES are reserved globally
  (case-insensitive), so nothing can be renamed into collision → 409
  `duplicate_category_name`. Group delete requires the group to be empty
  (400 `group_not_empty`, per Out of Scope). Group names unique
  case-insensitively; category names unique per group.
- UI: `web/src/pages/CategoriesPage.tsx`, a third top-nav view in `App.tsx`.
  Drag-free reorder via Up/Down buttons + a move-to-group select (keyboard
  accessible, NFR-9). Delete is a two-step on 409: the row grows the required
  target picker ("Reassign and delete") — no client-side history guessing.
  `onChanged` refetches `/api/categories` in the shell so pickers update
  immediately (AC-1); the grid refetches on view switch by construction.
- Tests: `server/test/web/categories-api.test.ts` (20) +
  `web/test/categories-page.test.tsx` (9).
