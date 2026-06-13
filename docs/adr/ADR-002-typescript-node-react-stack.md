# ADR-002: TypeScript end-to-end — Node 22 + Fastify backend, React + Vite SPA frontend

**Status:** Proposed (for Gate 2) · **Date:** 2026-06-12 · **Drivers:** NFR-1, NFR-9 (C4), NFR-6 (C2), SM-4 (C7); FR-20 (Plaid SDK), FR-32

## Context

Constraints pulling on the stack choice: a YNAB-grade interactive UI — keyboard-driven month grid and register with < 200 ms perceived edits (NFR-1/9) — which strongly implies a rich JavaScript client whatever the backend; Plaid ships official server SDKs for Node, Python, Java, Go, Ruby; money math must be exact-decimal (FR-32, solved at the data layer — ADR-004 — so it doesn't discriminate between languages); ≤ 1 GB RAM (NFR-6); and the dominant constraint: **one solo hobby maintainer for years** — long-term maintainability beats novelty, and the maintainer must enjoy the stack enough to fix it at 11 pm.

**Explicit assumption (Calvin must confirm at the gate):** Calvin is comfortable owning a TypeScript/Node/React codebase long-term. If his honest fluency is Python or Go, this ADR — and only this ADR — should be rewritten; ADR-001/003/…/008 survive a backend-language swap.

## Decision

- **Language:** TypeScript everywhere — one language, one toolchain, shared types across the API boundary (the request/response contract and the milliunit money types are defined once).
- **Backend:** Node 22 LTS + **Fastify** (fast, minimal, first-class TS, schema-validated routes), official `plaid` Node SDK, `better-sqlite3` (synchronous driver — correct fit for a single-user, single-writer app) with a thin query layer (Drizzle or hand-rolled), `argon2` for password hashing.
- **Frontend:** **React 18 + Vite** SPA; TanStack Query (server state, optimistic updates), TanStack Virtual (register virtualization at 10k rows), no heavyweight component framework — the month grid is custom (it is *the* product surface, NFR-9).
- All assets self-hosted in the app image (NFR-2); single multi-stage Dockerfile builds SPA + server into one image.

## Consequences

**Positive:** the interactivity-critical layer (the grid) is in the ecosystem with the deepest tooling for it; one language means one set of idioms, tests, and dependencies for a solo maintainer; shared TS types kill a whole class of API drift bugs; Node + SQLite idles around 100–250 MB — well under NFR-6; the Plaid SDK is first-party.

**Negative:** Node's JS ecosystem churns — mitigated by picking boring, huge-community libraries, pinning with a lockfile, and keeping the dependency count low; JavaScript's native number type is a footgun for money — neutralized structurally by integer milliunits (ADR-004) plus a lint ban on float arithmetic in money paths; React's own churn (versions, patterns) is real but the chosen subset (SPA + Query) is its most stable core.

## Alternatives considered

- **Python (FastAPI) + React:** official Plaid SDK, Calvin-friendly language candidate — but two languages/toolchains across the boundary and no shared types; the frontend would still be React, so the maintenance surface grows rather than shrinks. Viable runner-up if Calvin vetoes Node.
- **Go + React:** best RAM/footprint and a famously stable toolchain; same two-language tax, smaller web-app library ecosystem, more hand-rolling (sessions, migrations). Viable if Calvin is a Go person.
- **Rails or Django + Hotwire/HTMX (server-rendered):** superb solo-maintainer ergonomics for CRUD — but the month grid's keyboard-driven < 200 ms editing loop is exactly where server-round-trip-per-interaction patterns strain; would end up growing a JS layer anyway, now in two paradigms. Rejected on NFR-9.
- **Svelte/SolidJS frontend:** genuinely nice, smaller bundles — but smaller ecosystems and higher bus-factor risk for a years-long solo project; React's grid/virtualization/query tooling is deeper. Rejected on C7 (novelty < longevity).
- **Next.js (React meta-framework):** SSR/RSC machinery solves SEO and first-paint problems this LAN-only, auth-gated app doesn't have, at the cost of a heavier framework treadmill. A plain SPA + API is the simpler thing that meets the drivers. Rejected (see ADR-008).
