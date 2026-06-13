# ynab-clone

Self-hosted, single-user envelope-budgeting app (YNAB clone). TypeScript modular
monolith: Node 22 + Fastify, SQLite (`better-sqlite3`, WAL + `synchronous=FULL`),
React + Vite SPA — one container, one volume. See `docs/architecture.md` and
`docs/adr/` for the decisions; `docs/stories/` for the plan.

> Status: **E1–E7 complete.** Feature-complete MVP awaiting the SM-1
> parallel-run month. Designed for LAN/VPN exposure only (AS-2) — do not
> port-forward it to the internet.

## Dev quickstart

Requires Node >= 22 and npm.

```sh
npm install        # install all workspaces (shared, server, web)
npm test           # vitest suites (shared + server + web, incl. lint-boundary tests)
npm run lint       # eslint — enforces ADR-001 module boundaries + ADR-004 money rule
npm run typecheck  # tsc -b across all workspaces
npm run dev        # Fastify on :8080 (tsx watch) + Vite on :5173 (proxies /api)
npm run build      # shared + server (tsc) + web (vite) production build
```

For the dev server, point your browser at <http://localhost:5173>. The API dev
server needs a writable DB path and a master key, e.g.:

```sh
DATABASE_PATH=./data/app.db MASTER_KEY=$(openssl rand -hex 32) npm run dev -w @ynab-clone/server
```

---

# Operator guide (NFR-5: first run ≤ 30 minutes)

## First-run setup

On the home server (Docker + compose installed, LAN or Tailscale only — no
public URL, domain, or port-forwarding needed):

```sh
git clone <this repo> && cd ynab-clone     # or just copy docker-compose.yml + .env.example
cp .env.example .env
# 1. REQUIRED: generate the field-encryption master key (ADR-007)
sed -i.bak "s/^MASTER_KEY=$/MASTER_KEY=$(openssl rand -hex 32)/" .env && rm -f .env.bak
# 2. Optional: set PLAID_CLIENT_ID / PLAID_SECRET now, or later via Settings UI
docker compose up -d
```

Open `http://<host>:8080`. The first screen asks you to set the single user's
password — that completes setup. On every boot the container runs pending
forward-only schema migrations, verifies the NFR-11 balance checksum (below),
seeds the protected system categories, runs the NFR-12 money-math consistency
check, and only then serves traffic. All state lives in the `data` named
volume (`/data/app.db`, backups in `/data/backups/`).

The app **refuses to start without a valid `MASTER_KEY`** — that is by design
(ADR-007), not a bug. Generate one as above; never change it casually.

Migrating from YNAB? Use the **Migration** screen (upload the Register + Plan
CSVs from YNAB's export) BEFORE linking any bank connection.

## Backup (FR-35, RPO ≤ 24 h)

One command, one artifact (`VACUUM INTO` snapshot + manifest, safe while the
app runs):

```sh
docker compose exec app ynab-clone backup
```

A **daily backup also runs automatically inside the app** (keep-14 retention
over the scheduled artifacts), and the **Ops screen** has a "Back up now"
button + artifact list. Artifacts land in the data volume at `/data/backups/`.
Copying artifacts off-host is your job (OQ-7) — e.g. a nightly
`docker compose cp app:/data/backups ./offhost/` or any file-level sync.

**Back up `.env` (the `MASTER_KEY`) separately — it is deliberately NOT inside
any backup artifact.** (ADR-007)

## Restore (one command, RTO ≤ 1 h)

On the target host (same or new machine), with the same `.env` in place:

```sh
docker compose stop app                       # restore requires a stopped app
docker compose run --rm app ynab-clone restore /data/backups/<artifact>.tar.gz
docker compose up -d
```

Restore verifies the snapshot's SQLite integrity before swapping it in, keeps
the previous database aside as `app.db.replaced-<timestamp>`, and prints a
post-restore summary. An older artifact restored into a newer app version
simply migrates forward at boot (ADR-003).

If the artifact is on the host rather than in the volume, copy it in first:
`docker compose cp ./<artifact>.tar.gz app:/data/backups/` (or use
`docker run -v ynab-clone_data:/data …` while the app is stopped).

### Restore drill (quarterly — SM-4 counter-metric)

The scripted comparison from FR-35, in three commands (budget ~15 min, well
inside the 1 h RTO):

```sh
docker compose exec app ynab-clone summary > summary-before.json   # host A
# … restore the latest artifact on host B (or a scratch dir) as above …
docker compose exec app ynab-clone summary > summary-after.json    # host B
diff summary-before.json summary-after.json && echo "DRILL PASS"
```

`summary` prints canonical JSON: per-account working/cleared balances, the
latest month's Ready to Assign, transaction count, and the consistency-check
verdict. Identical output = identical state. (`ynab-clone check` exits
non-zero on any money-math mismatch, for scripting.)

### MASTER_KEY management — and what losing it costs

- The key lives **only** in `.env`. It is never written to the database, logs,
  or backups. Store a copy wherever you store passwords (password manager,
  printed in the safe — anywhere that is not the same disk).
- Rotating: don't, casually. The envelope format supports rotation
  (re-encrypt + bump key id), but no tooling ships for it yet.
- **If the key is lost** (restore onto a new host without the old `.env`):
  generate a fresh key, start the app, and **all transactions, accounts,
  budget months, and settings are fully intact** — the only ciphertext in the
  database is the Plaid client secret and the per-connection access tokens.
  Those become unreadable: the next sync attempt logs
  `TOKEN_DECRYPTION_FAILED` and flips the connection to *needs re-link*
  (banner + Connections screen), exactly like an expired bank login. Re-enter
  the Plaid secret in Settings and re-link each connection — nothing worse
  happens (the accepted ADR-007 consequence).

## Upgrade (NFR-11)

```sh
docker compose pull && docker compose up -d
```

On boot with pending migrations the entrypoint automatically:

1. takes a **pre-migration backup** (`ynab-clone-pre-migration-….tar.gz`,
   never reaped by retention),
2. records a **balance checksum** (every account's working/cleared sums, row
   counts, total assignments),
3. runs the forward-only migrations,
4. recomputes the checksum — **any difference aborts the boot loudly** (the
   container exits; logs name the mismatch and the backup to restore).

Rolling back = restore the pre-migration artifact with the previous image tag.

## Power loss / reboot (NFR-8)

Nothing to do: `restart: unless-stopped` brings the container back, SQLite's
WAL recovers committed writes (`synchronous=FULL` — an acknowledged write
survives kill -9), and the boot sequence re-verifies consistency.

## CSV export (FR-36)

**Ops screen → Download register CSV / budget CSV**, or curl with a session:

```sh
curl -b sid=<session-cookie> http://<host>:8080/api/export/register.csv -o register.csv
curl -b sid=<session-cookie> http://<host>:8080/api/export/budget.csv -o budget.csv
```

The register export is one row per accounting line (splits appear as their
category lines; re-totaling `Amount` per account reproduces every balance to
the cent). The budget export carries carryover/assigned/activity/available per
category per month. Everything is included: closed accounts, hidden
categories, transfers, statuses, approval, provenance.

## Money-math consistency check (NFR-12)

Runs at boot and after every migration; logs a summary, and a mismatch shows a
red banner on the **Ops** screen. Run it on demand there ("Run consistency
check"), via `docker compose exec app ynab-clone check`, or
`POST /api/admin/consistency/run`. It recomputes every account balance,
every category-month, and every month's RTA from raw rows via an independent
path and compares with exact integer equality.

## Sync outage fallback (UJ-6)

When a bank connection breaks (or Plaid is down), the file importer is a
first-class path, not a workaround:

1. In RBC online banking, download the account's recent activity as
   **OFX/QFX** (preferred) or CSV (~90-day window).
2. **Accounts → (account) → Import file** and upload it. Dedup matches
   anything the connection already imported; new rows land in the Review
   queue as usual.
3. Re-link the connection when the banner offers it — sync resumes from the
   stored cursor; overlap with the file import is deduplicated.

## Plaid: sandbox → production (OQ-2 gate)

The suite never calls Plaid (everything is faked at the `PlaidClientPort`
seam). Manual sandbox verification:

1. Get sandbox keys from the [Plaid dashboard](https://dashboard.plaid.com/);
   enter them via Settings (or `PLAID_CLIENT_ID`/`PLAID_SECRET` in `.env`).
2. **Connections → Add bank connection** — Plaid Link (the one NFR-2 CDN
   carve-out; the script loads only on that screen) accepts `user_good` /
   `pass_good`. Map discovered accounts to app accounts.
3. Sync from the UI (**Sync now**) or headless:
   `npm run sync:sandbox -w @ynab-clone/server` (dev).

**Before production:** in the Plaid dashboard, confirm the Trial/production
plan actually lists **RBC Royal Bank** as a supported institution for
`/transactions/sync` (the OQ-2 check — do this BEFORE relying on sync), then
flip the runtime setting: `PUT /api/settings/plaid_env` with
`{"value":"production"}` and re-enter production credentials in Settings.

## Release gates (run during the SM-1 parallel month)

- **NFR-2 (no telemetry):** `./scripts/ops/capture-network.sh` captures 24 h
  of the container's outbound connections and summarizes unique destinations —
  every one must be a Plaid endpoint (link/re-link flows excluded).
- **NFR-6 (footprint):** `./scripts/ops/sample-resources.sh` samples container
  CPU/RAM for 7 days into a CSV and prints averages — gate: ≤ 1 GB RAM, ≤ 5%
  average CPU.

## Optional: TLS via a reverse proxy (documented, not shipped)

The app serves plain HTTP and trusts `x-forwarded-proto` (secure cookies turn
on automatically behind TLS). On a trusted LAN or Tailscale (which encrypts
end-to-end) this is fine as-is. If you want TLS anyway, put Caddy in front:

```caddyfile
budget.lan {
  tls internal
  reverse_proxy app:8080
}
```

(Compose: add a `caddy` service joining the same network; do NOT publish the
app's port in that case.)

## Layout

```
shared/   @ynab-clone/shared — API types + branded Milliunits money (ADR-004)
server/   @ynab-clone/server — Fastify; modules: budget/ ledger/ importing/
          migration/ auth/ admin/ web/ (ADR-001 seams, lint-enforced)
          + db/ + migrations/ + the ynab-clone operator CLI (src/cli.ts)
web/      @ynab-clone/web — React SPA; built bundle served by the server (NFR-2)
scripts/  ops/ — NFR-2 network-capture + NFR-6 resource-sampling gate scripts
```

Conventions that lint/tests enforce: money is integer **milliunits** everywhere
(no float arithmetic outside `shared/src/money.ts`); every table is `STRICT`;
monetary columns are `INTEGER` named `*_milliunits`; migrations are ordered SQL
files in `server/migrations/`, recorded in `schema_migrations`, forward-only.
