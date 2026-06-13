# Stories — Tyche, a Self-Hosted YNAB-Style Budgeting App (MVP)

| | |
|---|---|
| **Status** | Ready for implementation — decomposed from `docs/prd.md` (Approved, Gate 1) and `docs/architecture.md` (Approved) |
| **Author** | story-planner (claude-toolkit SDLC) |
| **Date** | 2026-06-12 |
| **Scope** | MVP only: FR-1..28, FR-30..36. P2 items (FR-29, FR-37..39) have **no stories** by design. |

Each story file is self-contained (role-action-benefit, context, Given/When/Then ACs derived from the PRD's "Verified by" clauses, dev notes limited to decided architecture, out-of-scope fence, `[Source:]` references). A developer should implement from the story file plus its referenced sections alone.

## Epics

| Epic | Goal | Stories |
|---|---|---|
| **E1 — Foundation & access** | A deployable, authenticated, configurable skeleton everything else slots into | S1 walking-skeleton scaffold · S2 auth & sessions · S3 settings (Plaid creds, interval, password) |
| **E2 — Accounts & register** | The trustworthy ledger: accounts, transactions, splits, transfers, clearing, reconciliation | S1 accounts · S2 register view · S3 manual entry & payees · S4 splits · S5 transfers · S6 cleared status · S7 reconciliation |
| **E3 — Budget engine & month grid** | The product's heart: exact envelope math and the YNAB-grade grid | S1 budget engine · S2 month grid · S3 assign money · S4 move money · S5 RTA/overspend indicators · S6 category management |
| **E4 — File import & review pipeline** | The importer port + shared pipeline, proven with the OFX/CSV fallback backend first | S1 file import & pipeline core · S2 review queue · S3 duplicate matching |
| **E5 — Plaid sync** | Automatic RBC transactions through the same pipeline, resilient to breakage. **External dependency: OQ-2** — Calvin must verify in the Plaid dashboard that RBC is not Trial-excluded before this epic is scheduled against the real bank; sandbox development is not blocked. If excluded, file import becomes primary (a scheduling change per ADR-006, not a redesign). | S1 Plaid Link & mapping · S2 incremental sync · S3 polling scheduler · S4 re-link & sync health · S5 unlink |
| **E6 — YNAB migration** | Calvin's real history in, proven to the cent | S1 structure & transaction history · S2 assignments, idempotency & parity |
| **E7 — Ops & data ownership** | Backup/restore, export, deployment/upgrade hardening, consistency check | S1 backup & restore · S2 CSV export · S3 deploy/upgrade & README · S4 consistency check |

**30 stories total** (E1:3, E2:7, E3:6, E4:3, E5:5, E6:2, E7:4).

## Dependencies & sequence

```
E1.S1 (skeleton) ─► E1.S2 (auth) ─► everything else
                                      │
   E2.S1 (accounts) ──┬───────────────┘
   E3.S6 (categories) ┤        (both before any transaction work)
                      ▼
   E2.S2 (register) ─► E2.S3 (manual entry) ─► E2.S4 (splits), E2.S5 (transfers)
                      │                        E2.S6 (cleared) ─► E2.S7 (reconcile)
                      ▼
   E3.S1 (engine) ─► E3.S2 (grid) ─► E3.S3 (assign) ─► E3.S4 (move), E3.S5 (indicators)
                      │
                      ▼
   E4.S1 (file import + pipeline) ─► E4.S2 (review queue) ─► E4.S3 (matching)
                      │
   E1.S3 (settings/encryption) ─► E5.S1 (Link) ─► E5.S2 (sync) ─► E5.S3 (scheduler)
                                                  E5.S2 ─► E5.S4 (re-link/health) ─► E5.S5 (unlink)
                      │
   E2.S4 + E2.S5 + E4 pipeline ─► E6.S1 (migration) ─► E6.S2 (parity)
                      │
   E7.S1 (backup) · E7.S2 (export) · E7.S4 (consistency, after E3.S1) — anytime after their inputs
   E7.S3 (deploy/upgrade hardening) — last, verifies the whole envelope
```

Key cross-story contracts: E2.S4's split-line schema feeds E3.S1's activity sum; E1.S3's encryption module is reused by E5.S1; E4's pipeline is reused unchanged by E5.S2 and E6.S1; E3.S1's independent recompute is exposed by E7.S4.

## Suggested build order (walking skeleton early)

1. **Scaffold & access:** E1.S1 → E1.S2
2. **Ledger core:** E2.S1 → E3.S6 → E2.S2 → E2.S3 *(app is now usable for manual budgeting data entry)*
3. **Budget engine & grid:** E3.S1 → E3.S2 → E3.S3 → E3.S5 → E3.S4 *(the YNAB core loop works end to end)*
4. **Register completeness:** E2.S4 → E2.S5 → E2.S6 → E2.S7
5. **Import pipeline (Plaid-independent):** E4.S1 → E4.S2 → E4.S3 → E7.S4
6. **Plaid sync (sandbox; OQ-2 before production):** E1.S3 → E5.S1 → E5.S2 → E5.S3 → E5.S4 → E5.S5
7. **Migration:** E6.S1 → E6.S2
8. **Ops & release:** E7.S1 → E7.S2 → E7.S3 → SM-1 parallel-run month

## FR coverage (MVP)

| FR | Stories | | FR | Stories |
|---|---|---|---|---|
| FR-1 | E3.S1, E3.S2 | | FR-19 | E2.S3, E4.S1, E4.S2 |
| FR-2 | E3.S2 | | FR-20 | E5.S1, E5.S2 |
| FR-3 | E3.S1, E3.S2 | | FR-21 | E5.S2, E5.S3 |
| FR-4 | E3.S3 | | FR-22 | E4.S2 |
| FR-5 | E3.S4 | | FR-23 | E4.S3, E5.S2, E5.S4 |
| FR-6 | E3.S5, E3.S4 | | FR-24 | E4.S1 |
| FR-7 | E3.S5, E3.S4 | | FR-25 | E4.S1, E4.S3, E5.S2, E6.S1, E3.S1 |
| FR-8 | E3.S1 | | FR-26 | E5.S4 |
| FR-9 | E3.S6 | | FR-27 | E5.S2, E5.S4, E5.S5 |
| FR-10 | E2.S1, E3.S1 | | FR-28 | E5.S5 |
| FR-11 | E2.S1 | | FR-30 | E6.S1, E6.S2 |
| FR-12 | E2.S1, E2.S6 | | FR-31 | E6.S1, E6.S2 |
| FR-13 | E2.S2 | | FR-32 | E1.S1, E2.S3, E3.S1, E7.S2 (+ woven throughout) |
| FR-14 | E2.S3 | | FR-33 | E1.S2, E7.S2 |
| FR-15 | E2.S4 | | FR-34 | E1.S3, E5.S3 |
| FR-16 | E2.S5 | | FR-35 | E7.S1 |
| FR-17 | E2.S6, E2.S5, E2.S7 | | FR-36 | E7.S2 |
| FR-18 | E2.S7, E2.S6, E1.S1 (system-category seeding) | | | |

All 35 MVP FRs covered; FR-29/37/38/39 intentionally have no stories (P2).

**NFR placement:** NFR-1 → E2.S2, E3.S1..S3; NFR-2 → E1.S1, E5.S1, E7.S3; NFR-3 → E1.S3, E5.S1, E7.S1; NFR-4 → E5.S3; NFR-5/6/8/11 → E1.S1 + E7.S3; NFR-7 → E1.S1, E7.S1; NFR-9 → woven into E2.S2/S3/S6, E3.S2..S5, E4.S2, E5.S4; NFR-10 → E1.S2, E1.S3; NFR-12 → E3.S1, E7.S4 (+ woven into mutation stories).

## Open items for Calvin

- **OQ-2 (only unresolved OQ):** 5-minute Plaid-dashboard check that RBC isn't Trial-excluded — required before E5 is scheduled against production; sandbox work may proceed.
- Release gate after step 8 is **SM-1**: one full parallel-run month against YNAB with end-of-month RTA, every category available, and every account balance matching within $0.01.
