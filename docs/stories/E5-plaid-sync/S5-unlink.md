# Story E5.S5: Unlink a bank connection

Status: done

## Story

As Calvin, I want to unlink a bank connection so that I can revoke the app's access to my bank while keeping every transaction it ever imported.

## Context

Terminal state of the Item state machine: `ACTIVE | NEEDS_RELINK → UNLINKED`. Unlinking revokes the access token with Plaid (`/item/remove`) and discards the stored ciphertext; imported history is untouched. Trial-plan hygiene: removed Items free up slots under the 10-Item cap.

## Acceptance Criteria

- **AC-1** Given an Item, when Calvin unlinks it (with a confirmation step), then the access token is revoked at Plaid and discarded locally, the Item state becomes `UNLINKED`, and no further sync attempts occur for it. *(FR-28)*
- **AC-2** Given an unlinked Item, then all previously imported transactions remain intact in the register and all budget math is unchanged. *(FR-28)*
- **AC-3** Given a `NEEDS_RELINK` Item (token possibly dead), when unlinked, then local discard proceeds even if the Plaid revoke call fails, and the failure is logged to sync health. *(FR-28, FR-27)*
- **AC-4** Given an unlinked Item, then its record (institution, sync history, mappings) remains visible as inactive for audit, and the same bank can be re-linked later as a new Item.

## Dev Notes

- State machine: `UNLINKED` is terminal — re-linking creates a new Item; do not resurrect. [architecture §6]
- Scheduler skip for `UNLINKED` exists from E5.S3 (AC-4 there); this story adds the revoke + discard path.

## Out of Scope

- Deleting imported transactions on unlink (explicitly forbidden by FR-28), bulk unlink.

## References

- [Source: docs/prd.md#FR-28]
- [Source: docs/architecture.md#6-import-subsystem]
- [Source: docs/adr/ADR-006] · [Source: docs/adr/ADR-007]

## Completion Notes (2026-06-12)

- **AC-1**: `POST /api/plaid/items/:id/unlink` → `unlinkPlaidItem`
  (`importing/plaid/items.ts`): decrypt the token transiently, call the new
  port method `removeItem` (`/item/remove`; added to PlaidClientPort + the SDK
  adapter + all test fakes), then set status `UNLINKED` and blank
  `access_token_ciphertext` — nothing decryptable remains at rest. The
  confirmation step is the frontend's `window.confirm` (its copy promises the
  register stays intact). Syncing stops twice over: the route 409s non-ACTIVE
  Items and the S3 scheduler skips UNLINKED.
- **AC-3 — revoke is best-effort by design**: the Plaid call (or a missing
  client/master key) failing is CAUGHT, logged to plaid_sync_log as an error
  entry prefixed `unlink:`, and the local discard proceeds regardless. The
  route resolves the client leniently (no 400 on unconfigured Plaid) for the
  same reason.
- **AC-2/AC-4**: the row is never deleted — institution, mappings and sync
  log stay queryable/visible (connections screen renders UNLINKED Items
  read-only, controls hidden); the ledger is never touched (pinned:
  register before/after unlink is byte-identical).
- **No-resurrection decision (AC-4 + Dev Note)**: `plaid_items.plaid_item_id`
  is UNIQUE, but Plaid can report the SAME item id on a later link of the same
  bank (especially when the revoke failed). Unlink therefore tombstones the
  column (`<id> || ':unlinked:' || row id`), freeing the slot so
  `createLinkedItem` inserts a brand-new Item instead of resurrecting the
  terminal one. Unlink replays are no-ops (revoke not re-attempted).
- **Tests**: `server/test/web/plaid-relink-unlink-api.test.ts` (S5 block:
  revoke recorded by the fake, ciphertext blanked, 409 on later sync, history
  intact, failed-revoke path, unconfigured path, re-link-as-new-Item,
  idempotency) + connections-page unlink/confirm/read-only tests.
- **For E6 (YNAB migration)**: nothing here blocks it; note `rejected_externals`
  + T1 dedup remain the cross-backend memory. **For E7 (ops)**: UNLINKED rows
  are part of the audit surface — exports/consistency checks should include
  plaid_sync_log; blanked `access_token_ciphertext` ('') is expected and must
  not be flagged as corruption.
