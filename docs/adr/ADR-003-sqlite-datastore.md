# ADR-003: SQLite as the only datastore

**Status:** Proposed (for Gate 2) · **Date:** 2026-06-12 · **Drivers:** NFR-5, NFR-6 (C1, C2), NFR-7, FR-35 (C5), NFR-11 (C7)

## Context

Data volume is tiny and bounded: ~10k transactions over 5 years, ≤ 1 GB disk/year, one user, effectively one writer (the UI and the 6-hourly sync job). The backup requirement is pointed: a **single artifact**, produced and restored with **one command each** (FR-35), RPO ≤ 24 h, RTO ≤ 1 h (NFR-7), and a committed write must survive a hard kill. Deployability demands the fewest moving parts (NFR-5/6). The workload is read-heavy aggregation over small tables (ADR-005).

## Decision

**SQLite**, embedded in the app process (`better-sqlite3`), database file on the named Docker volume. Configuration: **WAL mode** + **`synchronous=FULL`** (an acknowledged commit survives power loss — NFR-7's kill -9 test), `foreign_keys=ON`, single connection (one writer by construction). Backup via **`VACUUM INTO`** — a consistent point-in-time snapshot taken while the app runs — packed with a settings manifest into one `.tar.gz` (FR-35). Schema migrations are forward-only, versioned, run automatically at boot (NFR-11), preceded by an automatic backup and bracketed by a balance checksum.

## Consequences

**Positive:** zero additional containers — the entire system is one service (NFR-5/6); backup/restore is fundamentally simple (one file), which makes the quarterly restore drill (SM-4) actually likely to happen; durability semantics are well-understood and testable; the data outlives the app — Calvin can open his ledger with the `sqlite3` CLI in 2035 (JTBD-4); recompute-heavy reads (ADR-005) run in-process with no network hop.

**Negative:** one writer — fine here, but a hard wall if NG-1 (multi-user) ever reverses; no `NUMERIC` type — money correctness must come from the application's integer-milliunit discipline (ADR-004) rather than the DB; fewer guard rails than Postgres (weaker typing) — mitigated by `STRICT` tables and CHECK constraints; `synchronous=FULL` costs an fsync per commit — irrelevant at single-user write rates.

## Alternatives considered

- **PostgreSQL (second compose service):** richer types (`NUMERIC`), concurrent writers, the "default" choice — but it adds a container (~100–200 MB RAM against the 1 GB cap), turns FR-35's one-command single-artifact backup into `pg_dump` orchestration plus version-compatibility care on restore, and adds upgrade coupling (Postgres major-version migrations) to NFR-11. Every benefit it offers maps to a non-driver. Rejected.
- **Postgres embedded alongside Node in one container:** recovers the single-container shape but is an unusual, fragile image to maintain solo. Rejected.
- **JSON/flat-file event log:** maximal transparency, but reimplements transactions, indexes, and crash-safety by hand — exactly the wheel SQLite is. Rejected.
- **LiteFS/Litestream replication for backups:** elegant continuous replication, but FR-35 asks for a one-command artifact and OQ-7 says local-disk artifact likely suffices; adds an operational concept. Not adopted now; compatible later if OQ-7 answers "push off-host."
