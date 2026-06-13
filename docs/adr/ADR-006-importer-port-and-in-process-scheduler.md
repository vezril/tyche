# ADR-006: Importer port with pluggable backends; in-process polling scheduler

**Status:** Proposed (for Gate 2) · **Date:** 2026-06-12 · **Drivers:** FR-20..31, NFR-4 (sync freshness), NFR-5 (no extra infra); R1/R2 (RBC/Plaid fragility); AS-7, AS-10

## Context

Transactions arrive four ways: Plaid `/transactions/sync` polling, manual OFX/QFX/CSV upload, the one-time YNAB migration, and manual entry. The feasibility report is blunt: the RBC↔Plaid connection **will** break periodically (`ITEM_LOGIN_REQUIRED`), and OQ-2 may yet demote Plaid to secondary. FR-25 requires budget math to be provenance-blind; FR-23 requires duplicate-safe matching *across* sources (a file import overlapping a synced period, a manual entry meeting its bank copy). Polling must run on schedule with no inbound URL and no external cron (NFR-4/5).

## Decision

1. **One importer port, three backends.** Each backend (Plaid sync, file parser for OFX/QFX/CSV, YNAB migration) implements `fetch/parse → StagedTransaction[]` — a common staging shape (account mapping hint, date, payee string, signed milliunits, external id, raw payload). Everything downstream is **shared and backend-agnostic**: normalize → dedup/match → review queue → ledger write through the same commands the UI uses.
2. **Matching tiers (FR-23):** (T1) exact external-id (Plaid `transaction_id`, OFX `FITID`) → idempotent apply/update; (T2) heuristic — same account + exact amount + date within ±5 days against unmatched register rows → merge, preserving user-entered category/memo, with user-visible unmatch; (T3) otherwise → new unapproved row in the review queue (FR-22).
3. **Item lifecycle as an explicit state machine (FR-26/28):** `LINKING → ACTIVE → NEEDS_RELINK → (ACTIVE | UNLINKED)`. `ITEM_LOGIN_REQUIRED` flips to `NEEDS_RELINK`: polling pauses for the item, a persistent banner shows last-success time, recovery is Link update mode (same item; cursor and account mappings preserved). Unlink revokes/discards the token and preserves history.
4. **Scheduler in-process:** a timer inside the app server fires the sync job (default 6 h, runtime-configurable — FR-34); `next_run_at` persisted so restarts neither skip nor stampede; manual "sync now" enqueues the same job; every attempt appended to a per-item sync-health log (FR-27). No cron container, no message queue.

## Consequences

**Positive:** FR-25 holds structurally — the ledger and budget cannot see `source`; when RBC breaks, the fallback is the *same pipeline* with a different front end, so behaviour (matching, review, payee suggestions) is identical and recovery fits SM-3's 15 minutes; if OQ-2 inverts the strategy, "file import primary" is a scheduling decision, not a redesign; sandbox-testing the pipeline tests all backends' shared 80%.

**Negative:** the staging shape is a least-common-denominator — Plaid-specific riches (pending→posted transitions, categories) must fit it or be carried in the raw payload; heuristic matching (T2) will occasionally mis-merge — bounded by limiting it to unmatched rows, surfacing merges in review, and providing unmatch (the SM-3 counter-metric, ≤ 1 duplicate/missing per month, is the fitness test); an in-process scheduler dies with the app — acceptable because `restart: unless-stopped` + persisted `next_run_at` means at most one delayed poll (within NFR-4's 95%-within-10-minutes window).

## Alternatives considered

- **Per-source pipelines** (Plaid writes directly, files separately): less indirection up front, but duplicates matching/review logic exactly where cross-source dedup (FR-23) lives; the overlap case becomes unsolvable cleanly. Rejected.
- **Host cron / separate scheduler container** hitting an internal endpoint: externalizes scheduling state but adds a moving part and breaks "configure interval in settings without redeploy" (FR-34). Rejected.
- **Plaid webhooks:** expressly off the table — requires a public URL (NFR-2/5, AS-7); polling is Plaid-sanctioned and sufficient at ~daily institution refresh. Rejected by requirement.
- **Generic plugin system (dynamically loaded importers):** NG-8 says no other banks/aggregators in MVP; a compile-time port is the right weight. Full plugin machinery rejected as speculative generality.
