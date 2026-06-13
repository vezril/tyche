# Story E7.S3: Production deployment, upgrade path, and operator README

Status: done (dev complete 2026-06-12; AC-1 timed clean-machine install, AC-4/AC-5 release gates, and the docker build/run remain for Calvin — daemon unavailable in the dev environment)

## Story

As Calvin (operator), I want a documented, ≤ 30-minute first-run setup and a `pull && up -d` upgrade path that can never silently corrupt my balances, so that operating this stays hobby-sized (SM-4).

## Context

Hardens the E1.S1 skeleton into the shippable operational envelope: published image (`ghcr.io/cference/tyche`), final compose file, first-run documentation, self-recovery, and the migration-safety bracket (pre-migration auto-backup + balance checksum before/after). This story is mostly verification and documentation of NFR-5/6/8/11 — the behaviors are spread across earlier stories; here they are proven end to end.

## Acceptance Criteria

- **AC-1** Given a clean machine and only the README, when a tester follows it (compose file, `.env` with generated `MASTER_KEY`, first-run password, Plaid keys), then the system is fully set up in ≤ 30 minutes with no public URL, domain, or port-forwarding. *(NFR-5)*
- **AC-2** Given a power loss or host reboot, when the host comes back, then the service is reachable without manual intervention (`restart: unless-stopped`, clean WAL recovery). *(NFR-8)*
- **AC-3** Given a new app version, when `docker compose pull && docker compose up -d` runs, then the entrypoint takes an automatic pre-migration backup, runs forward-only migrations, and verifies a balance checksum recorded before against after — aborting loudly on mismatch. *(NFR-11)*
- **AC-4** *(Release gate — see Dev Notes)* Given 24 h of normal use (excluding link flows), when network traffic is captured, then outbound connections go to Plaid endpoints only — no telemetry, CDN, or third-party fonts. *(NFR-2)*
- **AC-5** *(Release gate — see Dev Notes)* Given steady-state operation over 7 days, then container stats show ≤ 1 GB RAM and ≤ 5% average CPU. *(NFR-6)*
- **AC-6** Given the README, then it documents: backup/restore (incl. "back up `.env` separately"), upgrade, restore drill, the optional reverse-proxy TLS snippet (documented, not shipped), and the OFX/CSV fallback procedure for sync outages. *(NFR-5, ADR-007, ADR-008, UJ-6)*

## Dev Notes

- Compose shape, boot sequence (migrate → consistency check → serve + schedule), and upgrade bracket are specified in the architecture deployment view — implement as written. [architecture §8]
- Image publish workflow (GitHub Actions → ghcr.io) is implied by the image reference; keep it minimal.
- **Calendar-time gates:** AC-4 (24 h network capture) and AC-5 (7-day resource sampling) are release-gate checks executed during the SM-1 parallel-run month. The story's dev work is complete when the capture instrumentation and measurement procedure exist; the gates themselves are checked off later.

## Out of Scope

- Built-in TLS termination, dynamic DNS/Tailscale setup (user-side, AS-2), multi-arch beyond linux amd64/arm64 (AS-8).

## References

- [Source: docs/prd.md#NFR-5] · [Source: docs/prd.md#NFR-6] · [Source: docs/prd.md#NFR-8] · [Source: docs/prd.md#NFR-11] · [Source: docs/prd.md#NFR-2]
- [Source: docs/architecture.md#8-deployment-view]
- [Source: docs/adr/ADR-001] · [Source: docs/adr/ADR-003]

## Completion Notes (2026-06-12)

- **Boot order is now exactly architecture §8** (`server/src/web/boot.ts`,
  used by index.ts and tested in isolation): bracket(migrate) → seed →
  NFR-12 consistency check → serve → schedulers (Plaid poll + daily backup).
- **AC-3 (NFR-11 bracket):** pending migrations on existing data trigger an
  automatic pre-migration backup (`tyche-pre-migration-*.tar.gz`, exempt
  from retention) and a balance checksum (`server/src/admin/checksum.ts`:
  per-account working/cleared sums + row counts + total assignments, canonical
  JSON) recorded before and verified after; mismatch throws and index.ts exits
  non-zero — tested with a real benign migration (passes) and a malicious
  `UPDATE transactions` migration (aborts, backup left on disk).
- **AC-2:** `restart: unless-stopped` shipped since E1.S1; WAL +
  `synchronous=FULL` recovery per ADR-003. Compose config re-validated
  (`docker compose config` exit 0).
- **AC-4/AC-5 (release gates):** instrumentation + procedure exist —
  `scripts/ops/capture-network.sh` (24 h tcpdump in the container netns,
  unique-destination summary) and `scripts/ops/sample-resources.sh` (7-day
  docker-stats CSV + averages), both documented in README "Release gates".
  Executing them is the SM-1 parallel-run month's job.
- **AC-6:** README rewritten as the operator guide: first-run (≤ 30 min path),
  backup/restore + quarterly drill + "back up `.env` separately", MASTER_KEY
  management incl. loss consequences, upgrade bracket, power-loss behavior,
  CSV export, consistency check, OFX/CSV sync-outage fallback (UJ-6), Plaid
  sandbox→production with the OQ-2 dashboard check, reverse-proxy TLS snippet
  (documented, not shipped).
- **Image publish:** `.github/workflows/publish.yml` — tag `v*` → lint +
  typecheck + full suite gate → buildx multi-arch (amd64/arm64) push to
  `ghcr.io/cference/tyche` (AS-8).
- **NOT verifiable here (Docker daemon unavailable on this dev machine):**
  `docker compose build && docker compose up -d`, the in-container
  `tyche` shim, and the AC-1 timed clean-machine install. Everything
  inside the container boundary is verified (built `server/dist/cli.js`
  smoke-tested directly; compose config valid). Calvin: run
  `docker compose build && docker compose up -d`, then
  `docker compose exec app tyche backup`, and time a clean-machine
  first-run against the README.
