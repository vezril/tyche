# Story E1.S1: Walking-skeleton scaffold (single-container app, DB, CI of one)

Status: ready-for-dev

## Story

As Calvin (operator and sole developer), I want a runnable single-container skeleton of the app — server, SPA shell, database, migrations — so that every subsequent story adds a feature slice to a system that already deploys, boots, and persists.

## Context

This is the **one intentional exception** to "never split stories by layer": it establishes the platform every feature story builds on. It creates the TypeScript monorepo (Fastify backend + React/Vite SPA in one image), the SQLite database with the migration runner, the module boundaries (`budget/`, `ledger/`, `importing/`, `auth/`, `admin/`, `web/`), and the milliunit money foundation. No budget features yet — just a healthy "hello" page behind the compose file.

## Acceptance Criteria

- **AC-1** Given a clean machine with Docker, when `docker compose up -d` is run with the provided compose file and `.env`, then the app serves the SPA shell on the configured LAN port within one command, with no other containers and no inbound/public URL required. *(NFR-5)*
- **AC-2** Given the container boots, when startup runs, then pending forward-only schema migrations execute automatically before the HTTP server accepts traffic, and the SQLite database is created on the named volume with WAL mode, `synchronous=FULL`, and `foreign_keys=ON`. *(ADR-003, NFR-11)*
- **AC-3** Given a write is acknowledged by the API (use a placeholder settings write), when the container is `kill -9`'d immediately after, then the write is present after restart. *(NFR-7)*
- **AC-4** Given the SPA is loaded in a browser, when the page and its assets load, then every asset is served from the app container — zero third-party origins, CDNs, or fonts. *(NFR-2)*
- **AC-5** Given the codebase, when lint runs, then module-boundary rules (e.g., `budget` cannot import from `importing`) and the money rule (no float arithmetic on the branded `Milliunits` integer type outside the audited utils module) are enforced and a violation fails the build. *(FR-32, ADR-004, ADR-001)*
- **AC-6** Given the schema, then all monetary columns are `INTEGER` milliunits in `STRICT` tables. *(FR-32, ADR-004)*
- **AC-7** Given first-run initialization, when migrations complete, then the two protected system categories — *Inflow: Ready to Assign* and *Reconciliation adjustment* — are seeded, and they cannot be deleted, hidden, or renamed by category management (protection rule enforced in E3.S6). *(FR-18, architecture §5)*

## Dev Notes

- Stack is decided: Node 22 LTS + Fastify, `better-sqlite3` (single connection, one writer), React 18 + Vite SPA, shared TS types across the API boundary, multi-stage Dockerfile producing one image. Do not re-litigate. [ADR-002]
- Compose shape (service `app`, `data:` volume, `env_file: .env`, `restart: unless-stopped`) is given in the architecture deployment view.
- `MASTER_KEY` generation belongs to first-run setup (E1.S2/E1.S3); only reserve the `.env` slot here.

## Out of Scope

- Authentication (E1.S2), any domain endpoints, backup commands (E7.S1), production README polish and upgrade flow (E7.S3).

## References

- [Source: docs/prd.md#FR-32] · [Source: docs/prd.md#NFR-2] · [Source: docs/prd.md#NFR-5] · [Source: docs/prd.md#NFR-7]
- [Source: docs/architecture.md#2-architecture-style] · [Source: docs/architecture.md#5-domain-model--budget-math] · [Source: docs/architecture.md#8-deployment-view]
- [Source: docs/adr/ADR-001] · [Source: docs/adr/ADR-002] · [Source: docs/adr/ADR-003] · [Source: docs/adr/ADR-004]
