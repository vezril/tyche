# ADR-001: Modular monolith in a single container

**Status:** Proposed (for Gate 2) · **Date:** 2026-06-12 · **Drivers:** NFR-5, NFR-6, NFR-8, SM-4 (C1, C2, C7); FR-25

## Context

The PRD pins the operational envelope hard: one `docker compose up -d`, no inbound URL (NFR-5); ≤ 1 GB RAM, ≤ 5% CPU (NFR-6); best-effort availability with self-restart (NFR-8); total ops ≤ 30 min/month for a solo hobby maintainer (SM-4). There is exactly one user (NG-1), one host (AS-8), and one developer. At the same time, FR-25 demands a real seam: budget math must be provably independent of how a transaction arrived (Plaid, file, migration, manual), and the feasibility report predicts the import side will churn (RBC breakage, possible backend swaps).

## Decision

Build a **modular monolith**: one process, one deployable container, one architecture quantum. Partition internally **by domain** — `budget`, `ledger`, `importing`, `auth`, `admin`, `web` — with module boundaries enforced by directory structure and import-lint rules, not by network. The importer is a **microkernel-style port** inside the monolith: pluggable backends (Plaid sync, OFX/QFX/CSV, YNAB migration) behind one interface, all feeding a shared normalize → match → review pipeline. The polling scheduler runs in-process (no cron container, no external queue).

## Consequences

**Positive:** trivially meets NFR-5/6 (one container, ~100–250 MB); no distributed-computing fallacies to pay for; one log stream, one restart policy (NFR-8); FR-25's seam exists where it earns its keep without a network hop; a future "file import becomes primary" pivot (OQ-2 fallout) is a configuration of the port, not a re-architecture.

**Negative:** no independent deploy/scale of the importer — a bad importer release redeploys the budget engine too; a crash in any module restarts the whole process (acceptable under NFR-8's ≥ 99% target); module discipline relies on lint/review rather than process boundaries, and a solo maintainer can erode it — mitigated by the lint rule and ADRs recording the boundary's purpose.

## Alternatives considered

- **Microservices / service-based (separate importer service):** fault isolation and independent deploys nobody asked for; +1–2 containers, inter-service auth, versioned internal APIs — fails C2/C7 for zero driver benefit. Rejected.
- **Event-driven with a broker (Redis/NATS) for the import pipeline:** the pipeline is naturally sequential and low-volume (~tens of transactions/day); a broker adds a container and an operational concept for no throughput need. Rejected.
- **Plain layered monolith (technical partitioning):** same footprint, but FR-25's provenance-independence and the predicted importer churn argue for domain seams; layered structure invites the budget engine to reach into import internals. Rejected in favour of domain modules.
- **Local-first PWA (logic in the browser, server as sync store):** offline appeal, but NG-4 explicitly drops offline mode, and Plaid secrets must live server-side anyway; splits the money-math brain across two runtimes (hurts C6). Rejected.
