# Story E7.S1: One-command backup and restore

Status: done (dev complete 2026-06-12; AC-6 drill timing to be confirmed by Calvin on real hardware)

## Story

As Calvin (operator), I want a single command that produces one backup artifact and a documented one-command restore, so that my financial history survives hardware failure (JTBD-4) with RPO ≤ 24 h and RTO ≤ 1 h.

## Context

Backup = SQLite `VACUUM INTO` snapshot (consistent, safe while the app runs) + settings manifest, packed into one timestamped `.tar.gz` in `data/backups/`. Restore runs against a stopped app. The artifact contains ciphertext only — the `MASTER_KEY` in `.env` is deliberately excluded, so a restore without it recovers everything except live bank connections (re-link required, per the accepted ADR-007 consequence). Local-disk artifact is sufficient; off-host copies are Calvin's job (OQ-7 resolved).

## Acceptance Criteria

- **AC-1** Given the running app, when `docker compose exec app tyche backup` is run, then a single timestamped `.tar.gz` appears in `data/backups/` containing a consistent DB snapshot and settings manifest. *(FR-35)*
- **AC-2** Given a backup from host A, when `tyche restore <artifact>` runs on host B (app stopped) with the same `.env`, then a scripted comparison shows identical balances, RTA, and transaction counts, and Plaid syncing resumes. *(FR-35, NFR-7)*
- **AC-3** Given a restore on a host **without** the original `MASTER_KEY`, then all transactions and budget state are intact and the app starts; bank connections show as needing re-link — nothing worse. *(FR-35, ADR-007)*
- **AC-4** Given the backup artifact, when grepped, then no plaintext Plaid token or client secret is present. *(NFR-3)*
- **AC-5** Given a daily schedule (in-app daily job or documented host cron), then backups are produced automatically, satisfying RPO ≤ 24 h, with simple retention (e.g., keep N most recent). *(NFR-7)*
- **AC-6** Given the documented restore procedure, then a drill completes within RTO ≤ 1 h. *(NFR-7)*

## Dev Notes

- Mechanism decided: `VACUUM INTO` (point-in-time, online). Forward-only migrations mean restoring an older artifact into a newer app triggers normal boot migrations. [ADR-003]
- README's backup section must state in one line: back up `.env` separately. [ADR-007]
- The daily job may reuse E5.S3's timer infrastructure.

## Out of Scope

- Off-host push/replication (OQ-7: Calvin handles copies; NFR-2 constrains push anyway), backup encryption beyond the secrets already encrypted, retention policy UI.

## References

- [Source: docs/prd.md#FR-35] · [Source: docs/prd.md#NFR-7] · [Source: docs/prd.md#OQ-7]
- [Source: docs/architecture.md#8-deployment-view]
- [Source: docs/adr/ADR-003] · [Source: docs/adr/ADR-007]

## Completion Notes (2026-06-12)

- **Mechanism (AC-1):** `server/src/admin/backup.ts` — `VACUUM INTO` snapshot
  (online, point-in-time) + `manifest.json` (format tag, app version, applied
  migrations, non-secret settings, counts, explicit `masterKeyIncluded: false`)
  packed via system `tar` into ONE `tyche-backup-<UTC>.tar.gz` in
  `data/backups/`. CLI is `server/src/cli.ts`, installed in the image as
  `/usr/local/bin/tyche` (Dockerfile shim) so AC-1's exact command works:
  `docker compose exec app tyche backup`. Also `POST /api/admin/backup` +
  Ops-screen button and artifact list.
- **Restore (AC-2):** `tyche restore <artifact>` (stopped app) — extracts,
  verifies SQLite `integrity_check`, swaps in (old DB kept aside as
  `.replaced-<ts>`, stale WAL/SHM removed), prints a post-restore summary.
  FR-35's scripted comparison is `tyche summary` (canonical JSON:
  per-account working/cleared, latest-month RTA, transaction count,
  consistency verdict) — diff host A vs host B. AUTOMATED in
  test/admin/backup.test.ts (round-trip equality of balances/RTA/counts +
  Plaid secret readable with the same key) and executed for real on this
  machine via the CLI (drill passed, summaries identical).
- **Lost key (AC-3):** restore with a different MASTER_KEY keeps every
  transaction/budget/setting (tested); sync with an unreadable token now logs
  `TOKEN_DECRYPTION_FAILED`, flips the Item to NEEDS_RELINK (the E5.S4 banner
  + re-link path takes over), and returns clean `plaid_token_unreadable` —
  added in importing/plaid/sync.ts, tested in test/importing/plaid-sync.test.ts.
- **AC-4:** artifact + extracted snapshot/manifest byte-scanned for the
  plaintext Plaid secret, access token, and the hex MASTER_KEY — absent;
  ciphertext envelope present and decryptable (test).
- **AC-5:** in-app daily job `server/src/web/backup-scheduler.ts` (mirrors the
  E5.S3 timer-loop: last-run stamp in settings, claim-before-work, fake-clock
  tests), keep-14 retention over `tyche-backup-*` only — pre-migration
  artifacts and hand-copies are never reaped.
- **AC-6:** procedure documented in README (backup/restore/drill, incl. the
  one-line "back up `.env` separately"); local drill ran in well under a
  minute. The quarterly drill on Calvin's hardware remains an ops ritual.
- README "MASTER_KEY management" documents the loss consequence end to end.
