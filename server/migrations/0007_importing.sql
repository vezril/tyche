-- E4.S1–S3 import subsystem schema (FR-22..25, ADR-006, architecture §5/§6).
--
-- Conventions per 0001: STRICT tables, monetary columns are INTEGER
-- milliunits named *_milliunits (ADR-004), forward-only.
--
-- Three pieces of import state, all OUTSIDE the budget module's sight (FR-25):
--
--  * import_batches — provenance for every import run (S1 AC-3): which file,
--    which format, into which account, with per-row parse errors recorded as
--    JSON. The source CHECK already admits 'plaid'/'migration' so E5/E6 reuse
--    the same batch trail without another migration.
--
--  * rejected_externals — the rejected-import memory (S2 AC-4): rejecting an
--    unapproved row remembers its external id per account, so the same bank
--    transaction in the NEXT overlapping file/sync does not reappear.
--
--  * match_candidates — the T2 merge trail (S3, ADR-006): one row per merge,
--    carrying BOTH the imported side's identity/content (so unmatch can
--    resurrect it as its own row) and the register row's prior review state
--    (so unmatch can revert it). ON DELETE CASCADE: deleting a merged
--    transaction takes its match trail with it (foreign_keys=ON).

CREATE TABLE import_batches (
  id            TEXT NOT NULL PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts(id),
  source        TEXT NOT NULL CHECK (source IN ('file', 'plaid', 'migration')),
  filename      TEXT,
  format        TEXT CHECK (format IN ('ofx', 'csv')),
  created_count INTEGER NOT NULL DEFAULT 0,
  merged_count  INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  error_count   INTEGER NOT NULL DEFAULT 0,
  -- JSON array of { line, reason } per unparseable row (S1 AC-3).
  errors        TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- Which batch produced a transaction (provenance; import_id 0004 holds the
-- external identity itself).
ALTER TABLE transactions ADD COLUMN import_batch_id TEXT REFERENCES import_batches(id);

-- T1 exact external-id dedup: one lookup per staged row (ADR-006).
CREATE INDEX idx_transactions_account_import ON transactions(account_id, import_id);

CREATE TABLE rejected_externals (
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  external_id TEXT NOT NULL,
  rejected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (account_id, external_id)
) STRICT;

CREATE TABLE match_candidates (
  id                         TEXT NOT NULL PRIMARY KEY,
  -- The surviving (merged) register row.
  transaction_id             TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  import_batch_id            TEXT REFERENCES import_batches(id),
  source                     TEXT NOT NULL CHECK (source IN ('file', 'plaid', 'migration')),
  external_id                TEXT,
  -- The imported side's own content, preserved verbatim so unmatch can
  -- recreate it as a separate unapproved row (S3 AC-3).
  imported_date              TEXT NOT NULL,
  imported_payee             TEXT NOT NULL DEFAULT '',
  imported_memo              TEXT NOT NULL DEFAULT '',
  imported_amount_milliunits INTEGER NOT NULL,
  -- The register row's state before the merge, for the unmatch revert.
  prior_status               TEXT NOT NULL CHECK (prior_status IN ('uncleared', 'cleared', 'reconciled')),
  prior_approved             INTEGER NOT NULL CHECK (prior_approved IN (0, 1)),
  prior_import_id            TEXT,
  prior_import_batch_id      TEXT,
  matched_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- "Is this row already matched to a bank transaction?" — the T2 eligibility
-- check (S3 AC-4) and the review queue's match annotation (S3 AC-5).
CREATE INDEX idx_match_candidates_transaction ON match_candidates(transaction_id);
