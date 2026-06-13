-- E1.S3 settings & encryption (FR-34, NFR-3, ADR-007).
--
-- Secrets live in their own table, SEPARATE from the plain key/value settings
-- table, so the generic settings API can never read or return them. Values are
-- AES-256-GCM envelopes produced by the crypto module (v1.<keyId>.<iv>.<tag>.<ct>);
-- plaintext secrets never touch this file. The MASTER_KEY stays in .env and is
-- excluded from the DB and backups by construction.
CREATE TABLE credentials (
  name       TEXT PRIMARY KEY, -- e.g. 'plaid_secret'; E5.S1 adds access tokens
  value      TEXT NOT NULL,    -- versioned AES-256-GCM ciphertext envelope, never plaintext
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
