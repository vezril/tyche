# Story E5.S2: Incremental transaction sync from Plaid

Status: done

## Story

As Calvin, I want the app to pull added, modified, and removed transactions from Plaid through the shared import pipeline, so that my register fills itself and a manual "sync now" is always available.

## Context

The Plaid backend of the importer port: call `/transactions/sync` with the Item's persisted cursor, translate results into `StagedTransaction`s, and feed the existing normalize → match (E4.S3) → review (E4.S2) pipeline. Cursor advances only after successful application. This story covers the sync operation itself plus the manual trigger; the automatic schedule is E5.S3.

## Acceptance Criteria

- **AC-1** Given an `ACTIVE` Item with mapped accounts, when sync runs (manual "sync now"), then `added` transactions appear in the register as unapproved, cleared rows with Plaid `transaction_id` as external id, signed milliunits parsed from Plaid's decimal strings (never via float). *(FR-21, FR-32, ADR-004)*
- **AC-2** Given a transaction `modified` upstream (e.g., pending→posted with amount/date change), when sync runs, then the existing row (matched by external id, T1) is updated without duplicating and without discarding Calvin's category/memo. *(FR-21, FR-23)*
- **AC-3** Given a transaction `removed` upstream, when sync runs, then an unapproved row is removed/voided, and an approved row is flagged for user attention in the review queue rather than silently deleted. *(FR-21, architecture §6)*
- **AC-4** Given transactions for unmapped/skipped bank accounts, then they are ignored. *(FR-20)*
- **AC-5** Given a sync failure mid-stream, then the cursor is not advanced past unapplied data — re-running resumes without loss or duplication. *(FR-21, FR-23)*
- **AC-6** Given an identical transaction arriving via sync vs file vs manual entry, then category/RTA effects are identical. *(FR-25)*
- **AC-7** Given every sync attempt, then an entry (timestamp, outcome, counts) is appended to the Item's sync-health log. *(FR-27)*

## Dev Notes

- Backend emits `StagedTransaction[]`; all matching/review behavior is the shared pipeline's — do not special-case in the backend. [ADR-006]
- Plaid-specific riches (pending flag, Plaid categories) ride in the raw payload; do not model them. [ADR-006]
- Verify in sandbox using Plaid's sandbox transaction firing.

## Out of Scope

- Scheduling (E5.S3), `ITEM_LOGIN_REQUIRED` handling and banner (E5.S4 — this story may treat it as a generic failure logged to sync health), balance import (FR-29, P2).

## References

- [Source: docs/prd.md#FR-21] · [Source: docs/prd.md#FR-23] · [Source: docs/prd.md#FR-25] · [Source: docs/prd.md#FR-27]
- [Source: docs/architecture.md#6-import-subsystem]
- [Source: docs/adr/ADR-004] · [Source: docs/adr/ADR-006]

## Completion Notes (2026-06-12)

- **Backend of the importer port** (`importing/plaid/sync.ts` — `syncPlaidItem`): pages
  `/transactions/sync` from the Item's stored cursor; `added`+`modified` become
  `StagedTransaction`s (`externalId = transaction_id`, `accountHint = account_id`,
  Plaid riches verbatim in `raw`) grouped per mapped app account and fed to
  `runImport(source:'plaid')` — matching/review/budget effects are the shared pipeline's
  by construction (AC-6 pinned: a Plaid row T2-merges a manual entry exactly like file
  import, category/memo kept).
- **AC-1**: Plaid's sign convention (positive = outflow) inverted in
  `plaidAmountToMilliunits`; the parse itself is the audited shared string parser — the
  amount never exists as a float (the SDK adapter converts the SDK's number via
  shortest-round-trip `String()`, exact for 2-decimal amounts; all MATH is on the string).
- **AC-2**: extended the pipeline's T1 branch with `applyUpdates: true` (Plaid-only;
  file import keeps E4's skip): a changed redelivery updates bank-owned fields
  (date/amount, uncleared→cleared) in place via the ledger seam, preserves the user's
  category/memo/payee, drops the row to unapproved (FR-22); content-identical redelivery
  stays an idempotent skip.
- **AC-3 — removed-handling decision**: handled in the backend (not the pipeline — a
  removal is not a staged row). The external id is ALWAYS remembered in
  `rejected_externals` (never resurrects through any backend); an unapproved copy is
  deleted (voided); an approved copy is NEVER silently deleted — memo gains
  "Removed by bank", row drops to unapproved and resurfaces in the review queue.
  Replays are no-ops.
- **AC-4**: transactions whose `account_id` is unmapped, skipped, or unknown are counted
  (`ignoredUnmappedCount`) and ignored.
- **AC-5 — cursor discipline**: each page is applied in ONE SQLite transaction that also
  advances `plaid_items.cursor`; a mid-stream failure leaves the cursor on the last
  applied page and a re-run resumes (T1 dedup makes redelivery a no-op).
  `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` restarts the loop from that same stored
  cursor (max 3 restarts, then surface the error) — pinned by the scripted-fake tests.
- **AC-7**: `appendSyncLog` writes BOTH outcomes (counts; Plaid `error_code` on failure);
  surfaced as `lastAttempt`/`lastSuccessAt`/`syncLog` on `GET /api/plaid/items`.
- **HTTP**: `POST /api/plaid/items/:id/sync` (manual "sync now", also wired to the
  ConnectionsPage button); upstream `PlaidApiError` → 502 `plaid_api_error` + plaidCode;
  not-ACTIVE → 409; unknown Item → 404.
- **Sandbox**: suite is fully offline (fake `PlaidClientPort`); manual verification via
  `npm run sync:sandbox -w @ynab-clone/server` (README "Plaid sandbox").
- **For S3 (scheduler)**: call `syncPlaidItem(db, masterKey, client, itemId)` per ACTIVE
  Item — same code path as manual sync; it throws on failure AND logs to
  `plaid_sync_log`, so the scheduler only needs catch-and-continue. **For S4**: a failed
  sync's `PlaidApiError.plaidCode === 'ITEM_LOGIN_REQUIRED'` is the NEEDS_RELINK trigger
  (this story records it as a generic failure in the log); re-link via the existing
  link-token + `createLinkedItem` upsert. **For S5**: set status `UNLINKED`; account
  links cascade on Item delete.
