# Story E5.S3: In-process polling scheduler

Status: done

## Story

As Calvin, I want syncs to run automatically on a configurable schedule with no extra infrastructure, so that my register is never more than one polling interval stale without me thinking about it.

## Context

An in-process timer inside the app server — no cron container, no queue, no inbound URL. Default interval 6 hours, runtime-configurable via settings (E1.S3). `next_run_at` is persisted so restarts neither skip nor stampede. The scheduler invokes the same sync job as "sync now" (E5.S2) for each `ACTIVE` Item.

## Acceptance Criteria

- **AC-1** Given the scheduler running with sandbox Items, when a transaction is added in Plaid sandbox, then it appears in the register within one polling interval without any user action. *(FR-21, NFR-4)*
- **AC-2** Given a changed polling interval in settings, when saved, then the new interval takes effect without restart or redeploy. *(FR-34, NFR-4)*
- **AC-3** Given a container restart, when the app boots, then `next_run_at` is honored: an overdue poll runs once promptly (no skipped slot, no burst of catch-up polls). *(ADR-006, NFR-4)*
- **AC-4** Given an Item in `NEEDS_RELINK` or `UNLINKED`, then the scheduler skips it. *(FR-26, FR-28)*
- **AC-5** Given scheduler operation over time, then logs/sync-health entries demonstrate polls executing on schedule (NFR-4's measure: ≥ 95% within 10 minutes of slot over 7 days — verifiable from the recorded attempts). *(NFR-4, FR-27)*
- **AC-6** Given a manual "sync now" while a scheduled run is in flight, then runs do not overlap per Item (single-flight).

## Dev Notes

- Decided: in-process timer, persisted `next_run_at`, manual refresh enqueues the same job. [ADR-006]
- `restart: unless-stopped` + persisted schedule = at most one delayed poll after a crash; acceptable per ADR-006.

## Out of Scope

- Webhooks (rejected by requirement), per-Item custom intervals (one global interval per FR-34), daily backup scheduling (E7.S1 may reuse the timer infrastructure).

## References

- [Source: docs/prd.md#FR-21] · [Source: docs/prd.md#FR-34] · [Source: docs/prd.md#NFR-4] · [Source: docs/prd.md#AS-7]
- [Source: docs/architecture.md#6-import-subsystem]
- [Source: docs/adr/ADR-006]

## Completion Notes (2026-06-12)

- **Placement decision**: the scheduler lives in the COMPOSITION layer
  (`server/src/web/plaid-scheduler.ts`), not `importing/` — it is pure wiring
  (interval from admin/settings, credentials from admin/plaid, the sync job
  from importing), and ADR-001's boundary forbids importing→admin. Wired into
  boot in `server/src/index.ts` only; `buildApp` stays timer-free for tests.
- **Schedule persistence decision (AC-3)**: ADR-006 says "persisted
  next_run_at"; we persist the LAST poll time (`plaid_sync_last_poll_at` in
  the settings table — no migration needed) and DERIVE the next slot as
  `last + current interval`, with the interval read live from
  `polling_interval_hours` on every check. Same restart contract (overdue →
  one prompt poll, not-due → wait, never a burst) AND a changed interval takes
  effect at the very next check without restart (AC-2/FR-34's verified-by) —
  a stored absolute next_run_at can't do that. The slot is claimed (re-stamped)
  BEFORE syncing, so a crash mid-poll costs at most one delayed poll.
- **Loop mechanics**: `start()` runs an immediate check, then a setTimeout
  chain every `checkEveryMs` (default 60 s — well inside NFR-4's 10-minute
  window); `tick()` is exposed and the whole thing takes injectable
  `now()`/timers, so the suite (test/web/plaid-scheduler.test.ts, 11 tests)
  drives time without sleeping and never starts a real timer.
- **AC-4**: only `ACTIVE` Items sync; NEEDS_RELINK/UNLINKED/LINKING are
  skipped. Per-item catch-and-continue (syncPlaidItem already logs both
  outcomes to plaid_sync_log — AC-5's evidence trail) and ITEM_LOGIN_REQUIRED
  flips the Item to NEEDS_RELINK via S4's hook inside syncPlaidItem itself.
- **AC-6 single-flight**: `PlaidSyncGate` — a per-item in-flight promise map.
  ONE gate instance is created in index.ts and shared between the scheduler
  and the manual-sync route (buildApp option `plaidSyncGate`); a "sync now"
  during a scheduled run JOINS that run (same result), never double-syncs.
  Manual syncs deliberately do not re-stamp the schedule — the next slot
  stays put and T1 dedup makes the overlap a no-op.
- **For E7 (ops)**: the timer-loop infrastructure here is reusable for E7.S1's
  daily backup (ADR-006 anticipated this); scheduler health is observable from
  plaid_sync_log timestamps (NFR-4's ≥95%-within-10-min check) plus the
  `plaid_sync_last_poll_at` setting.
