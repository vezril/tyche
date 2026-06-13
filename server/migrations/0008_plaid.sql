-- E5.S1–S2 Plaid sync schema (FR-20/21/26/27, ADR-006, ADR-007, architecture §6).
--
-- Conventions per 0001: STRICT tables, forward-only, monetary columns are
-- INTEGER milliunits (none here — Plaid state holds no money).
--
--  * plaid_items — one row per Plaid Item (one RBC login). The access token
--    is stored ONLY as the AES-256-GCM envelope produced by crypto/ (NFR-3,
--    ADR-007); the sync cursor is plaintext by design (useless without the
--    token). `status` is the ADR-006 Item state machine; S1 covers
--    LINKING → ACTIVE, S4/S5 will drive NEEDS_RELINK/UNLINKED.
--
--  * plaid_account_links — the discovered-bank-account → app-account mapping
--    (FR-20, S1 AC-3). account_id NULL + skipped 0 = "discovered, not yet
--    decided"; skipped 1 = the user said no. Either way, sync produces no
--    transactions for it (S2 AC-4).
--
--  * plaid_sync_log — one row per sync ATTEMPT (FR-27, S2 AC-7): timestamp,
--    outcome, counts, and the upstream error code when it failed (S4 reads
--    error_code to drive NEEDS_RELINK).

CREATE TABLE plaid_items (
  id                      TEXT NOT NULL PRIMARY KEY,
  -- Plaid's item_id, used to correlate with the dashboard/sandbox.
  plaid_item_id           TEXT NOT NULL UNIQUE,
  institution_name        TEXT,
  -- v1.<keyId>.<iv>.<tag>.<ct> envelope from crypto/encryptField — NEVER plaintext.
  access_token_ciphertext TEXT NOT NULL,
  -- /transactions/sync cursor; NULL until the first successfully applied page.
  -- Advanced only inside the same transaction that applied the page (S2 AC-5).
  cursor                  TEXT,
  status                  TEXT NOT NULL DEFAULT 'LINKING'
                          CHECK (status IN ('LINKING', 'ACTIVE', 'NEEDS_RELINK', 'UNLINKED')),
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE plaid_account_links (
  id               TEXT NOT NULL PRIMARY KEY,
  plaid_item_id    TEXT NOT NULL REFERENCES plaid_items(id) ON DELETE CASCADE,
  -- Plaid's account_id — the StagedTransaction.accountHint sync routes by.
  plaid_account_id TEXT NOT NULL,
  name             TEXT NOT NULL DEFAULT '',
  mask             TEXT,
  type             TEXT NOT NULL DEFAULT '',
  subtype          TEXT,
  -- The mapped app account; NULL = unmapped (or skipped).
  account_id       TEXT REFERENCES accounts(id),
  skipped          INTEGER NOT NULL DEFAULT 0 CHECK (skipped IN (0, 1)),
  UNIQUE (plaid_item_id, plaid_account_id)
) STRICT;

CREATE TABLE plaid_sync_log (
  id             TEXT NOT NULL PRIMARY KEY,
  plaid_item_id  TEXT NOT NULL REFERENCES plaid_items(id) ON DELETE CASCADE,
  at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  outcome        TEXT NOT NULL CHECK (outcome IN ('success', 'error')),
  -- Counts of what THIS attempt applied (S2 AC-7).
  added_count    INTEGER NOT NULL DEFAULT 0,
  updated_count  INTEGER NOT NULL DEFAULT 0,
  removed_count  INTEGER NOT NULL DEFAULT 0,
  -- Upstream Plaid error code (e.g. ITEM_LOGIN_REQUIRED) when outcome='error'.
  error_code     TEXT,
  message        TEXT
) STRICT;

CREATE INDEX idx_plaid_sync_log_item ON plaid_sync_log(plaid_item_id, at);
