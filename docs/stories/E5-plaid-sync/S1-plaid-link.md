# Story E5.S1: Link an RBC login via Plaid and map accounts

Status: done

## Story

As Calvin, I want to connect my RBC login through Plaid Link and map each discovered bank account to an app account, so that bank transactions can flow in automatically (JTBD-3).

## Context

Implements the `LINKING → ACTIVE` leg of the Item state machine: create link token → user completes the Link widget → exchange public token for access token → store token encrypted → present discovered accounts for mapping (or skip). One RBC login = one Item; Trial plan allows ≤ 10 Items. **External dependency (epic-level, not a blocker for sandbox work): OQ-2 — Calvin must verify in the Plaid dashboard that RBC is not Trial-excluded before this epic is scheduled against the real bank. All ACs are verifiable in Plaid sandbox.**

## Acceptance Criteria

- **AC-1** Given Plaid credentials in settings (E1.S3), when Calvin starts "Add connection," then the backend creates a link token and the Link widget completes in sandbox, producing an Item in `LINKING` state. *(FR-20)*
- **AC-2** Given a completed Link, when the public token is exchanged, then the access token is stored AES-256-GCM-encrypted (never plaintext in DB or logs) and the Item moves to `ACTIVE` after mapping. *(NFR-3, ADR-007)*
- **AC-3** Given discovered bank accounts, when presented, then each is individually mappable to an existing app account or marked skipped; unmapped/skipped accounts produce no transactions on sync. *(FR-20)*
- **AC-4** Given the Plaid Link widget, then its CDN script loads **only** on the connection-management screens during link/re-link — no other page references any third-party origin. *(NFR-2, ADR-008)*
- **AC-5** Given the connections screen, then each Item shows institution, mapped accounts, and state.

## Dev Notes

- Official `plaid` Node SDK; reuse E1.S3's encryption module for the access token. [ADR-002, ADR-007]
- PlaidItem entity: institution, encrypted access_token, cursor (null until first sync), status, account mappings, sync-attempt log (log written by E5.S2/S4). [architecture §5]
- No webhooks anywhere — polling-only design. [ADR-006, AS-7]

## Out of Scope

- Transaction sync (E5.S2), scheduler (E5.S3), re-link/update mode (E5.S4), unlink (E5.S5), tracking balance true-up (FR-29, P2).

## References

- [Source: docs/prd.md#FR-20] · [Source: docs/prd.md#NFR-2] · [Source: docs/prd.md#NFR-3] · [Source: docs/prd.md#OQ-2]
- [Source: docs/architecture.md#6-import-subsystem]
- [Source: docs/adr/ADR-006] · [Source: docs/adr/ADR-007] · [Source: docs/adr/ADR-008]

## Completion Notes (2026-06-12)

- **Schema** (migration `0008_plaid.sql`, STRICT): `plaid_items` (one row per Item;
  `access_token_ciphertext` holds ONLY the crypto-module AES-256-GCM envelope; `cursor`
  NULL until the first applied sync page; `status` CHECK-constrained to the ADR-006 state
  machine), `plaid_account_links` (discovered bank account → app account; `account_id`
  NULL + `skipped` 0/1 — three distinct states: mapped / skipped / no-decision-yet), and
  `plaid_sync_log` (FR-27, written by S2).
- **Plaid client seam** (`importing/plaid/client.ts` — `PlaidClientPort`): the ONLY path
  to Plaid. Tests inject a fake factory via `buildApp({ plaidClientFactory })`; the one
  real implementation (`sdk.ts`, official `plaid` npm SDK per ADR-002) is constructed by
  the web layer (`web/plaid-routes.ts`) from admin-module credentials — importing may not
  import admin (ADR-001). Amounts cross the seam as decimal STRINGS.
- **AC-1/AC-2**: `POST /api/plaid/link-token` → `POST /api/plaid/items` (public-token
  exchange) → Item in `LINKING` with the token encrypted via `crypto/encryptField`
  (ADR-007); `PUT /api/plaid/items/:id/mappings` applies the per-account decisions
  atomically and moves LINKING → ACTIVE. NFR-3 pinned by test: raw SQLite bytes (db +
  WAL) and captured log output contain no plaintext token; the logger redaction list
  already covered `accessToken`/`access_token`; no API response carries the token.
- **AC-3**: every discovered account individually mappable/skippable; unmapped AND
  skipped both produce no transactions (enforced in S2's sync — `ignoredUnmappedCount`).
- **AC-4 — Link loading decision: hand-rolled loader**, not `react-plaid-link`
  (`web/src/pages/plaid-link.ts`): the CDN script tag is injected only when a link flow
  starts on the (lazy-loaded) `ConnectionsPage` chunk — no other page/chunk references a
  third-party origin (NFR-2/ADR-008 carve-out verbatim). Component test pins that render
  never touches the loader.
- **AC-5**: `GET /api/plaid/items` → institution, state, per-account mapping (+
  `lastAttempt`/`lastSuccessAt`/`syncLog` for FR-27); `ConnectionsPage` renders it with
  the mapping table and Sync now.
- **Environment**: `plaid_env` runtime setting (default `sandbox`; `PLAID_ENV` env var as
  fallback) read at client-construction time — production is a deliberate flip (OQ-2).
- Re-linking the same `plaid_item_id` updates the token in place, preserving id, cursor
  and mappings — this is the S4 update-mode contract; `createLinkedItem` is reusable as-is.
- **For S4/S5**: drive `NEEDS_RELINK`/`UNLINKED` via `plaid_items.status` (CHECK already
  permits them); `plaid_sync_log.error_code` carries `ITEM_LOGIN_REQUIRED` today.
