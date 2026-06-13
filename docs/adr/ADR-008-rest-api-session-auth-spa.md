# ADR-008: REST API + server-side cookie sessions + self-hosted SPA

**Status:** Proposed (for Gate 2) · **Date:** 2026-06-12 · **Drivers:** NFR-9, NFR-1 (C4 interactivity), NFR-2 (no CDN/third-party at runtime), NFR-10 (LAN-scoped security), FR-33, FR-36/JTBD-4 (scriptable data access)

## Context

Three coupled decisions: API shape, rendering strategy, and auth. The app is auth-gated, single-user, LAN/VPN-only (AS-2): **SEO is irrelevant, first-paint-for-anonymous-visitors is irrelevant** — the classic arguments for SSR/SSG don't apply. What does apply: YNAB-grade interactivity (keyboard-driven grid/register, < 200 ms perceived edits — NFR-9/1), the no-CDN rule (NFR-2), and data ownership (Calvin should be able to curl his own data — JTBD-4). One complication: Plaid Link is a JS widget loaded from Plaid's CDN — and NFR-2 carves out exactly that exception for link flows.

## Decision

- **API: REST** — resource-oriented JSON endpoints (accounts, transactions, categories, months/assignments, items, settings, backup, export), schema-validated (Fastify + shared TypeScript types generated into the client), documented via OpenAPI. Mutations return the recomputed balances they affected so the client can reconcile optimistic state in one round trip.
- **Rendering: pure SPA (CSR)** — React + Vite bundle served by the app container itself; all JS/CSS/fonts self-hosted (NFR-2). Optimistic UI for assignment edits and approvals (< 200 ms perceived), with the server's recomputed numbers (ADR-005) as the always-authoritative correction. Register virtualized for 10k+ rows. Responsive ≥ 380 px for UJ-3/UJ-4 (NFR-9).
- **Plaid Link exception, scoped:** the Link script is referenced **only** by the connection-management screens and loaded on demand during link/re-link — matching NFR-2's carve-out verbatim; the 24 h network-capture test (which excludes link flows) sees Plaid API traffic only.
- **Auth: server-side sessions** (FR-33, NFR-10): single account, argon2id password hash; opaque session id in an `HttpOnly`, `SameSite=Lax` cookie; session records in SQLite with a configurable 30-day idle expiry; login rate-limited in-app (≥ 5 failures → ≥ 60 s lockout). CSRF: SameSite plus a required custom header on mutations. Every route — page data and API alike — requires the session. TLS is the trust boundary's job (LAN, or Tailscale's end-to-end encryption); an optional nginx/Caddy TLS snippet is documented, not shipped.

## Consequences

**Positive:** the interactivity bar is met where it's won — in the client — with the server kept simple (JSON in, JSON out); REST keeps the API usable from `curl`/scripts for export and backup automation without the app's frontend (JTBD-4, FR-36); cookie sessions are the lowest-complexity correct auth for a single user on a trusted network — no token refresh machinery, no JWT revocation problem; no SSR runtime means less server RAM (C2) and one fewer framework treadmill (C7).

**Negative:** first load downloads the bundle — irrelevant on LAN and mitigated by code-splitting (the grid, the register, settings); no offline tolerance (explicitly out of scope, NG-4); REST needs a few pragmatic non-resource endpoints (`/sync/run`, `/backup`) — named verbs, documented, not dogma; SameSite=Lax + custom-header CSRF must be tested, not assumed (automated auth tests per NFR-10).

## Alternatives considered

- **tRPC / RPC-style API:** end-to-end types with zero codegen — tempting in a TS monorepo — but welds the API contract to the TypeScript client toolchain, hurting the curl-ability and longevity goals (JTBD-4, C7). Shared types over REST capture most of the benefit. Rejected.
- **GraphQL:** flexible queries for many clients — there is one client and ~30 endpoints; pure overhead here. Rejected.
- **SSR/meta-framework (Next.js/Remix) or server-rendered + HTMX:** solves SEO/first-paint problems this app doesn't have; the grid's per-keystroke editing loop pushes toward a rich client anyway (see ADR-002's Rails/HTMX analysis). Rejected.
- **JWT auth:** stateless tokens buy horizontal scale and cross-service federation — neither exists; cost is awkward revocation and refresh plumbing. Rejected.
- **Basic auth / reverse-proxy auth (Authelia etc.):** fewer moving parts or more, respectively; basic auth can't do idle expiry/rate-limit semantics of NFR-10, and a proxy auth layer adds a container (NFR-5/6). Rejected.
