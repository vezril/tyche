# Story E1.S3: Settings — Plaid credentials, polling interval, password change

Status: ready-for-dev

## Story

As Calvin, I want a settings screen to manage my Plaid credentials, the sync polling interval, and my password, so that I can reconfigure the running system without redeploying.

## Context

Settings persist in SQLite. The Plaid client secret is the first secret stored at rest, so this story implements the AES-256-GCM field-encryption envelope (ADR-007) that the Plaid epic (E5) reuses for access tokens. The polling interval is consumed by the scheduler (E5.S3) — here it only needs to be stored, validated, and exposed.

## Acceptance Criteria

- **AC-1** Given the settings screen, when Calvin saves a Plaid client ID and secret, then they are persisted and subsequently used by Plaid calls; the secret is shown masked after save. *(FR-34)*
- **AC-2** Given a saved Plaid client secret, when the SQLite file is inspected directly, then only AES-256-GCM ciphertext is present (random nonce per value, key id in the envelope); the `MASTER_KEY` from `.env` is never written to the DB or logs. *(NFR-3, ADR-007)*
- **AC-3** Given any log output (including error paths), when settings are saved or used, then no secret material appears — the logger's redaction layer covers secret-bearing fields. *(NFR-3, ADR-007)*
- **AC-4** Given a new polling interval, when saved, then it takes effect at runtime without container restart or redeploy (verified once the scheduler exists; until then, the stored value is readable via the settings API). *(FR-34, NFR-4)*
- **AC-5** Given the current password, when Calvin changes it (current password required), then the new argon2id hash replaces the old and existing other sessions are invalidated. *(FR-34, NFR-10)*
- **AC-6** Given Plaid credentials provided via `.env` (`PLAID_CLIENT_ID`/`PLAID_SECRET`), when the app boots, then they seed settings as an alternative to UI entry. *(architecture deployment view)*
- **AC-7** Given the settings screen, when Calvin changes the session idle-expiry duration (a configurable setting, default 30 days), then the saved value governs session expiry (consumed by E1.S2's session checks). *(FR-34, NFR-10)*

## Dev Notes

- Build the encryption helper as a small reusable module at the persistence boundary; E5.S1 encrypts access tokens with it. Key rotation support = key id in envelope (rotation procedure itself not built now). [ADR-007]
- The session idle-expiry setting (NFR-10) is owned here (AC-7); E1.S2 reads it rather than hard-coding the duration.

## Out of Scope

- The scheduler itself (E5.S3), Plaid Link flow (E5.S1), backup of settings (E7.S1).

## References

- [Source: docs/prd.md#FR-34] · [Source: docs/prd.md#NFR-3] · [Source: docs/prd.md#NFR-4]
- [Source: docs/architecture.md#6-import-subsystem] · [Source: docs/architecture.md#8-deployment-view]
- [Source: docs/adr/ADR-007]
