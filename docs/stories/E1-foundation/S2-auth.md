# Story E1.S2: Single-user authentication & sessions

Status: ready-for-dev

## Story

As Calvin, I want the app locked behind a password with a long-lived session on my trusted network, so that my financial data is never exposed unauthenticated, even on the LAN.

## Context

Single user account, no registration flow. First boot enters a setup mode that creates the password (and generates `MASTER_KEY` into `.env` if absent). Every page and API route thereafter requires a valid session. Threat model is LAN/VPN-only (AS-2) — no public-internet hardening beyond NFR-10.

## Acceptance Criteria

- **AC-1** Given no user exists, when the app is first opened, then a one-time setup screen creates the single account password; afterwards the setup route is permanently unavailable. *(FR-33)*
- **AC-2** Given no valid session, when any page or API endpoint is requested, then the API returns an auth challenge (401) and the SPA redirects to login — no budget data in any unauthenticated response. *(FR-33)*
- **AC-3** Given valid credentials, when Calvin logs in, then an opaque session id is set in an `HttpOnly`, `SameSite=Lax` cookie, the session record is stored in SQLite, and it expires after the idle period configured in the settings story's idle-expiry setting (E1.S3; default 30 days) — not a hard-coded value. *(NFR-10, ADR-008)*
- **AC-4** Given 5 consecutive failed login attempts, when a 6th is made within the lockout window, then login is refused for at least 60 seconds regardless of password correctness. *(NFR-10)*
- **AC-5** Given the stored credential, then it is an argon2id hash — the plaintext password is never persisted or logged. *(NFR-10)*
- **AC-6** Given a mutation request without the required custom CSRF header, when it reaches the API, then it is rejected; automated tests cover the SameSite + custom-header CSRF scheme. *(ADR-008)*

## Dev Notes

- Sessions live in SQLite (no Redis); single account, no roles (NG-1). No JWT, no OAuth — decided in ADR-008.
- Logout endpoint invalidates the server-side session row.
- TLS is out of scope (trust boundary = LAN/Tailscale per AS-2); a reverse-proxy snippet is documentation only (E7.S3).

## Out of Scope

- Password *change* UI (E1.S3 settings). Multi-user anything (NG-1). Public-internet hardening (AS-2).

## References

- [Source: docs/prd.md#FR-33] · [Source: docs/prd.md#NFR-10] · [Source: docs/prd.md#AS-2]
- [Source: docs/architecture.md#7-api--auth]
- [Source: docs/adr/ADR-008]
