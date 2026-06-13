# Story E5.S4: Broken-connection handling, re-link, and sync health

Status: done

## Story

As Calvin, I want the app to tell me loudly when the RBC connection breaks and let me fix it with Plaid's update mode, so that sync outages cost me minutes, not corrupted data (UJ-6, SM-3: recovery ≤ 15 minutes).

## Context

RBC breakage is an expected operating condition (AS-10, risk R1), not a defect. A sync returning `ITEM_LOGIN_REQUIRED` flips the Item to `NEEDS_RELINK`: polling pauses for that Item, a persistent banner shows app-wide with the last-successful-sync time, and recovery is Link **update mode** — same Item, cursor and account mappings preserved. Sync health (last attempt, last success, recent outcomes) becomes user-visible.

## Acceptance Criteria

- **AC-1** Given a sandbox-simulated `ITEM_LOGIN_REQUIRED`, when a sync attempt hits it, then the Item state flips to `NEEDS_RELINK`, scheduled polling pauses for it, and a prominent persistent banner appears showing the connection and its last-successful-sync time. *(FR-26)*
- **AC-2** Given a `NEEDS_RELINK` Item, when Calvin completes Link update mode, then the banner clears, the Item returns to `ACTIVE`, and the next sync resumes from the preserved cursor without re-mapping accounts and without duplicate transactions. *(FR-26, FR-23)*
- **AC-3** Given the connection detail view, then it shows last attempt time, last success time, and the outcome of recent attempts; after a failed poll, the failure and its timestamp are visible there. *(FR-27)*
- **AC-4** Given other (non-auth) sync errors, then they are logged to sync health and surfaced in the detail view without flipping the Item to `NEEDS_RELINK`. *(FR-27)*
- **AC-5** Given the banner, then it links directly to the re-link action and is visible on phone viewports. *(FR-26, NFR-9)*

## Dev Notes

- State machine is fixed: `ACTIVE → NEEDS_RELINK → (ACTIVE | UNLINKED)`. Update mode keeps the same Item/access token grant — do not create a new Item. [architecture §6, ADR-006]
- Link widget CDN exception applies to update mode exactly as to initial link. [ADR-008, NFR-2]
- The file importer (E4.S1) is the documented fallback while broken — banner copy may point to it.

## Out of Scope

- Unlink (E5.S5), email/push alerts (NG-5 — the banner is the notification), automatic retry backoff tuning beyond skipping paused Items.

## References

- [Source: docs/prd.md#FR-26] · [Source: docs/prd.md#FR-27] · [Source: docs/prd.md#UJ-6] · [Source: docs/prd.md#AS-10] · [Source: docs/prd.md#SM-3]
- [Source: docs/architecture.md#6-import-subsystem] · [Source: docs/architecture.md#9-risk-storm]
- [Source: docs/adr/ADR-006] · [Source: docs/adr/ADR-008]

## Completion Notes (2026-06-12)

- **AC-1**: the flip lives INSIDE `syncPlaidItem`'s failure path
  (`importing/plaid/sync.ts`): a `PlaidApiError` with code
  `ITEM_LOGIN_REQUIRED` (constant `PLAID_ITEM_LOGIN_REQUIRED`) calls
  `markNeedsRelink` — guarded `WHERE status='ACTIVE'` — so manual sync and the
  S3 scheduler both trigger it with zero caller cooperation; the scheduler then
  skips the Item (S3 AC-4) and the sync route 409s it (paused). Any OTHER
  Plaid error is logged to sync health without touching state (AC-4).
- **Banner (AC-1/AC-5)**: `web/src/pages/SyncBanner.tsx`, rendered by the
  SHELL (`App.tsx`) above every view — pinned by a shell-level test that shows
  it on the budget view. Names the connection, shows last-successful-sync
  time (from the items payload), points at the file-import fallback, and its
  "Re-link now" button hands the item id to the connections screen which
  auto-starts update mode (`relinkItemId` prop) — one click from banner to
  Link. Banner component is Plaid-free: the CDN loader still ships ONLY in the
  lazy connections chunk (verified against the built bundles — NFR-2/ADR-008).
  Mobile styles per NFR-9.
- **Re-link (AC-2) — update-mode decision**: new port method
  `createUpdateLinkToken(accessToken)` (`POST /api/plaid/items/:id/relink-token`)
  creates the Link token AGAINST the Item's stored access token (SDK adapter
  omits `products`, per Plaid's update-mode docs). On Link success the
  frontend posts `/:id/relinked` → `completeRelink` flips NEEDS_RELINK→ACTIVE;
  there is NO public-token exchange — update mode keeps the existing grant, so
  cursor and mappings are untouched by construction and the next sync resumes
  from the stored cursor (pinned: redelivered rows T1-dedup, no duplicates).
  Belt-and-braces: a FULL re-exchange of the same `plaid_item_id` also heals —
  `createLinkedItem`'s upsert now restores NEEDS_RELINK→ACTIVE with the fresh
  token (LINKING stays LINKING).
- **Sync health (AC-3)**: no new endpoint — `GET /api/plaid/items` already
  carried `lastAttempt`/`lastSuccessAt`/`syncLog` (S1/S2); the connections
  screen now renders last attempt time, last success time, and a "Sync
  history" detail table (outcome + counts, or error code/message + timestamp
  for failures).
- **Tests**: server `test/web/plaid-relink-unlink-api.test.ts` (fake-driven
  ITEM_LOGIN_REQUIRED → status + banner data; update-mode token uses the
  Item's token; relink preserves cursor/mappings, no dupes; non-auth errors
  don't flip) + scheduler pause coverage in `plaid-scheduler.test.ts`; web
  `sync-banner.test.tsx` + connections-page re-link/health tests.
