# Story E4.S1: OFX/QFX/CSV file import (and the import pipeline core)

Status: done

## Story

As Calvin, I want to upload an RBC-exported OFX/QFX or CSV file into a chosen account, so that when Plaid↔RBC breaks (UJ-6) — or before sync exists at all — bank transactions still flow into my register.

## Context

This story builds the **importer port and shared pipeline** (normalize → stage → review) with the file backend as its first client; Plaid (E5) and migration (E6) plug into the same port later. Every backend emits the common `StagedTransaction` shape (account-mapping hint, date, payee string, signed milliunits, external id, raw payload). File import is deliberately first: it de-risks the pipeline independent of OQ-2 (Plaid/RBC eligibility). Matching tiers land in E4.S3; this story may insert all rows as new-unapproved, but must record external ids (OFX `FITID`) for S3.

## Acceptance Criteria

- **AC-1** Given a real RBC OFX/QFX export, when uploaded into a chosen account, then transactions appear as unapproved register rows with correctly parsed dates, payees, and signed amounts (outflows negative), and `FITID` stored as the external id. *(FR-24)*
- **AC-2** Given a real RBC CSV export, when uploaded, then the review queue is populated with correctly parsed dates, payees, and signed milliunit amounts (parsed via string, never float). *(FR-24, FR-32, ADR-004)*
- **AC-3** Given a file with unparseable rows, when imported, then valid rows import, invalid rows are reported per-row with reasons, and the import is recorded as an ImportBatch with provenance. *(architecture §5/§6)*
- **AC-4** Given an imported transaction, then it arrives `cleared` and `unapproved`, with payee canonicalized and the payee's last-used category pre-suggested. *(FR-19, FR-22, architecture §6)*
- **AC-5** Given an identical transaction entered manually vs imported from a file, then its category/RTA effects on the budget are identical — budget math never sees `source`. *(FR-25)*
- **AC-6** Given the upload UI, then it requires choosing the target app account before import (files carry no reliable account mapping). *(FR-24)*

## Dev Notes

- Importer port interface and `StagedTransaction` shape are decided — build them here, backend-agnostic downstream. [ADR-006]
- Importing writes to the ledger only through the same command interface the UI uses. [ADR-001, architecture §2]
- RBC export window is ~90 days rolling — no special handling needed, but don't assume files start at account inception.

## Out of Scope

- Duplicate/heuristic matching (E4.S3 — until then re-importing the same file may duplicate; acceptable interim), the review queue UI (E4.S2), Plaid backend (E5), YNAB migration backend (E6).

## References

- [Source: docs/prd.md#FR-24] · [Source: docs/prd.md#FR-25] · [Source: docs/prd.md#UJ-6] · [Source: docs/prd.md#AS-10]
- [Source: docs/architecture.md#6-import-subsystem]
- [Source: docs/adr/ADR-004] · [Source: docs/adr/ADR-006]

## Completion Notes (2026-06-12)

- **Importer port** (`server/src/importing/port.ts`): `StagedTransaction` per ADR-006 —
  date / payee / signed milliunits / `externalId` / memo / `accountHint` / `raw`. The file
  backend is `importing/filefmt/` (detect by extension, then content sniff); the shared
  downstream is `runImport()` in `importing/pipeline.ts`. E5/E6 plug in by emitting staged
  rows with `source: 'plaid' | 'migration'` — the port doc comment spells out what Plaid
  must know (T1 "apply as update" extension point, `removed` semantics deferred to E5.S2).
- **OFX**: tolerant minimal OFX 1.x SGML parser (`filefmt/ofx.ts`) — `<STMTTRN>` blocks only,
  no closing-tag requirement (OFX 2.x XML parses identically), DTPOSTED accepts timezone
  suffixes, TRNAMT accepts `+`/thousands-commas; no new dependency. **CSV** (`filefmt/csv.ts`):
  real RBC columns ("Account Type…CAD$, USD$"), header matched by NAME not position,
  M/D/YYYY dates, quoted fields with commas; USD-only rows refused per-row, never guessed.
  ALL amounts parse via the audited string-based `parseDollarsToMilliunits` (ADR-004) —
  the importing module is under the no-`*`//`/` money lint like every domain module.
- AC-3: `import_batches` (migration `0007_importing.sql`, STRICT) records provenance +
  per-row errors as JSON; valid rows import, invalid rows return `{line, reason}` to the client.
- AC-4: rows arrive `cleared` + `approved=0` through `ledger.createTransaction` (the single
  write seam — extended with `importId`/`importBatchId` rather than bypassed); payees
  canonicalize case-insensitively and the last-used category is set on the row (FR-19).
- AC-5: pinned by test — identical manual vs imported transactions produce byte-identical
  `getBudgetMonth` output (`pipeline.test.ts`).
- AC-6: upload is `POST /api/accounts/:id/import` (account in the URL = explicit user
  choice); multipart via `@fastify/multipart` (first-party, 10 MB cap), behind the session
  wall + CSRF like every mutation. UI: "Import file…" on the register header
  (`web/src/pages/RegisterPage.tsx`), with a per-import summary line incl. skipped rows.
- Fixtures: `server/test/importing/fixtures/rbc-chequing.{ofx,csv}` — realistic CAD data,
  10+ rows each: duplicate FITID, ± amounts, timezone'd + plain dates, thousands commas,
  MEMO-only fee row, cheque number, USD-only row, bad date/amount rows.
- Tests: `server/test/importing/{ofx,csv}-parser.test.ts` (19), `pipeline.test.ts` (19, with
  S3), `server/test/web/import-api.test.ts` (11, with S2/S3). Suite 349 → 403, lint/
  typecheck/build clean.
