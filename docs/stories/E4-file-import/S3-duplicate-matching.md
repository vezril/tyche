# Story E4.S3: Duplicate detection, matching, and unmatch

Status: done

## Story

As Calvin, I want incoming imported transactions matched against what's already in the register and merged instead of duplicated, so that overlapping imports, re-imports, and my own manual entries never corrupt the ledger (SM-3 counter-metric: ≤ 1 duplicate/missing per month).

## Context

The three-tier matcher from ADR-006, applied between staging and the review queue for **every** backend: T1 exact external-id (Plaid `transaction_id`, OFX `FITID`) → idempotent apply/update/skip; T2 heuristic — same account + exact amount + date within ±5 days against *unmatched* register rows → merge, preserving the user's category/memo and attaching the import identity; T3 → new unapproved row. Merges are user-visible and reversible (unmatch).

## Acceptance Criteria

- **AC-1** Given a file import overlapping an already-imported period (same external ids), when run, then zero duplicate transactions are created; re-running the exact same import is a no-op. *(FR-23)*
- **AC-2** Given a manually entered $43.10 transaction, when the bank copy arrives (same account, same amount, date within ±5 days), then they merge into one register row keeping the manual category/memo and gaining the import's external id and cleared status. *(FR-23)*
- **AC-3** Given a merged row, when Calvin chooses unmatch, then the merge is undone: the manual row reverts and the imported row appears separately as unapproved. *(FR-23)*
- **AC-4** Given T2 candidates, then only rows without an existing import identity are eligible (a row already matched to one bank transaction is never merged with a second). *(ADR-006)*
- **AC-5** Given a merge, then it is surfaced in the review queue as a match (distinct from a plain new row) so mis-merges are noticed during daily review. *(FR-22, ADR-006)*
- **AC-6** Given identical content arriving via file vs (later) Plaid, then matching behavior and budget effects are the same — the matcher is backend-agnostic. *(FR-25)*

## Dev Notes

- MatchCandidate/ImportBatch entities carry the review/unmatch trail. [architecture §5]
- T2 mis-merges are an accepted bounded risk; unmatch is the mitigation — make it discoverable on the transaction, not buried. [ADR-006]
- Cross-source dedup is the whole reason the pipeline is shared — do not implement matching inside any single backend. [ADR-006]

## Out of Scope

- Fuzzy amount/date-window tuning UI, payee-similarity matching (not in ADR-006's tiers), Plaid `removed` handling (E5.S2).

## References

- [Source: docs/prd.md#FR-23] · [Source: docs/prd.md#FR-25] · [Source: docs/prd.md#SM-3]
- [Source: docs/architecture.md#6-import-subsystem]
- [Source: docs/adr/ADR-006]

## Completion Notes (2026-06-12)

- **Matcher** (`importing/pipeline.ts`, backend-agnostic, between staging and review per
  ADR-006): **T1** exact external id per account (index `idx_transactions_account_import`)
  → skip, idempotent; duplicate FITIDs *within* one file also collapse. **T1b** (decision):
  sources with no external id (RBC CSV) dedup by content identity — same account/date/
  amount against import-borne rows, PLUS recorded merges checked by their *imported* date
  (the merged row sits on the manual entry's date) — this is what makes "same CSV twice"
  a true no-op without inventing fake ids. **T2** same account + exact amount + date
  within ±5 days (inclusive; closest date wins ties) against rows with NO import identity
  and no match record (AC-4), starting balances excluded. **T3** new unapproved row.
  Rows created/consumed in the current run are never match targets (two real $5 coffees
  in one file stay two rows).
- **Merge semantics** (AC-2): the existing row keeps category/memo/payee/date, gains the
  import's external id + cleared status (reconciled rows keep their lock), and drops to
  `approved=0` so the merge surfaces in the daily review (AC-5) — write goes through the
  new ledger-seam command `setImportIdentity`.
- **Unmatch** (AC-3): `match_candidates` (migration 0007) stores the imported side's full
  content AND the row's pre-merge state (status/approved/prior import identity);
  `POST /api/transactions/:id/unmatch` reverts the row exactly and recreates the import
  as its own unapproved row. Affordance in BOTH the review queue (match note) and the
  register ("Unmatch" action on rows with `hasImportMatch`, enriched in the web layer so
  the ledger stays import-blind).
- AC-6: pinned by test — the same staged row via `source: 'plaid'` merges identically;
  budget equivalence pinned in S1's AC-5 test.
- Property tests (`pipeline.test.ts`): same OFX twice / same CSV twice / randomized
  seeded batches twice → zero new rows; manual-then-import → merged not duplicated;
  window boundary (5 in, 6 out); second bank copy never merges an already-matched row.
