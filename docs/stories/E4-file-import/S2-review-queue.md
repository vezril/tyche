# Story E4.S2: Review queue — approve, edit, reject imported transactions

Status: done

## Story

As Calvin, I want a review queue where imported transactions wait for my approval, so that my daily transaction review (UJ-3) is a fast confirm/edit loop and nothing enters my trusted ledger unseen.

## Context

All imported rows (file now, Plaid later, same pipeline) arrive `unapproved`. The queue surfaces them across accounts; approving confirms payee/category; editing must never clobber the imported amount/date identity. Rejecting removes the row but must remember its external id so the same bank transaction doesn't reappear on the next import/sync.

## Acceptance Criteria

- **AC-1** Given unapproved transactions, when the review queue is opened, then they are listed (newest first) with account, date, payee, suggested category, and amount; unapproved rows are visibly distinct in registers too. *(FR-22)*
- **AC-2** Given a queued transaction, when Calvin edits only its category (or payee/memo), then approval proceeds without altering the imported amount or date. *(FR-22)*
- **AC-3** Given approve/edit/reject actions, then each is available per row and as keyboard shortcuts; a typical day's review is completable in ≤ 2 minutes. *(FR-22, NFR-9)*
- **AC-4** Given a rejected transaction, then it leaves the register, and a subsequent import containing the same external id does not recreate it. *(FR-22, FR-23-adjacent)*
- **AC-5** Given approval, then the transaction's category/payee feed the payee last-used-category suggestion for next time. *(FR-19)*
- **AC-6** Given a phone-sized viewport (≥ 380 px), then the queue is fully usable (UJ-3/UJ-4 surface). *(NFR-9)*

## Dev Notes

- Approval is a flag flip plus optional field edits through the standard ledger command layer; activity math already includes unapproved rows (architecture §5: "approved-or-not") — approval is about *review*, not budget effect.
- The queue is the surface where Plaid `removed` flags and T2 merge results appear later (E5.S2, E4.S3) — leave room in the row model for a status note.

## Out of Scope

- Matching/unmatching UI (E4.S3), bulk approve-all (P2 quality-of-life), Plaid-specific states (E5).

## References

- [Source: docs/prd.md#FR-22] · [Source: docs/prd.md#FR-19] · [Source: docs/prd.md#UJ-3] · [Source: docs/prd.md#NFR-9]
- [Source: docs/architecture.md#6-import-subsystem]
- [Source: docs/adr/ADR-006]

## Completion Notes (2026-06-12)

- **Queue**: `GET /api/review` (`importing/review.ts: listReviewQueue`) — all unapproved
  parent rows across accounts, newest first, each with account name, T2 match annotation
  (S3 AC-5's "status note" room in the row model), and the payee's last-used category as
  the suggestion when the row is uncategorized. UI: `web/src/pages/ReviewPage.tsx`, a new
  "Review" nav view with a count badge; unapproved rows were already visibly distinct in
  registers (E2's `.unapproved` styling) — the queue uses the same amber accent.
- AC-2: approval is `POST /api/transactions/:id/approve` →
  `ledger.approveTransaction(id, {categoryId?, payeeName?, memo?})` — amount/date are not
  in the edit type, not in the route schema, and not rendered as inputs; structurally
  un-clobberable. Approval routes edits through `updateTransaction`, so all transfer/
  split/tracking rules hold.
- AC-3: per-row Approve / Edit / Reject buttons plus keyboard loop (J/K or arrows move,
  A approve, R reject, E edit, U unmatch) — one keypress per typical row.
- AC-4: `rejected_externals` (migration 0007) keys (account_id, external_id); reject
  records the id then deletes through the ledger seam; the pipeline checks it before T1.
  Rejecting a MERGED row first unmatches, so the user's own transaction survives — only
  the bank copy is rejected. Approved rows refuse rejection (409) — delete is their path.
- AC-5: `approveTransaction` records the payee→category pairing on every approval (not
  just on category change), so confirmation teaches the FR-19 suggestion.
- AC-6: card-style rows wrap at ≤700 px; category picker and action buttons go full-width
  (380 px usable, no horizontal panning).
- Tests: `server/test/web/import-api.test.ts` (queue/approve/reject over HTTP, reject
  memory across re-import), `web/test/review-page.test.tsx` (5 component tests incl. the
  keyboard loop and AC-2's "only category/payee/memo posted").
