-- E2.S1–S3 ledger schema: accounts, payees, transactions (FR-10..14, FR-19).
--
-- Conventions per 0001: STRICT tables, monetary columns are INTEGER
-- milliunits named *_milliunits (ADR-004), forward-only.
--
-- NO stored balances anywhere (ADR-005): account working/cleared balances are
-- SUM() queries over transactions. The starting balance is a REAL transaction
-- row (is_starting_balance = 1) so it is auditable, exportable, and included
-- in every recompute by construction (NFR-12, FR-30).

CREATE TABLE accounts (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('chequing', 'savings', 'tracking')),
  -- Derived from type at creation (tracking = 0) but stored, per architecture §5,
  -- so the budget engine (E3) can SELECT on it without knowing type semantics.
  on_budget  INTEGER NOT NULL CHECK (on_budget IN (0, 1)),
  closed     INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- Account names are unique case-insensitively ("chequing" duplicates "Chequing").
CREATE UNIQUE INDEX idx_accounts_name_nocase ON accounts(name COLLATE NOCASE);

-- Payee list built as a side effect of entry/import (FR-19). last_category_id
-- remembers the most recent categorization for the default suggestion.
CREATE TABLE payees (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  last_category_id TEXT REFERENCES categories(id),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE UNIQUE INDEX idx_payees_name_nocase ON payees(name COLLATE NOCASE);

CREATE TABLE transactions (
  id                  TEXT PRIMARY KEY,
  account_id          TEXT NOT NULL REFERENCES accounts(id),
  -- ISO YYYY-MM-DD; lexicographic order == chronological order, so date
  -- range filters and sorts are plain string comparisons on the index.
  date                TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- Signed: negative = outflow, positive = inflow (ADR-004).
  amount_milliunits   INTEGER NOT NULL,
  payee_id            TEXT REFERENCES payees(id),
  -- NULL for uncategorized rows and ALWAYS NULL on tracking accounts (FR-10,
  -- enforced in ledger code); E3 computes activity from this column.
  category_id         TEXT REFERENCES categories(id),
  memo                TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'uncleared'
                        CHECK (status IN ('uncleared', 'cleared', 'reconciled')),
  -- Manual entries are approved; imported rows arrive unapproved (FR-22).
  approved            INTEGER NOT NULL DEFAULT 1 CHECK (approved IN (0, 1)),
  source              TEXT NOT NULL DEFAULT 'manual'
                        CHECK (source IN ('manual', 'plaid', 'file', 'migration')),
  -- External identity for dedup (Plaid transaction_id / OFX FITID), E4/E5.
  import_id           TEXT,
  is_starting_balance INTEGER NOT NULL DEFAULT 0 CHECK (is_starting_balance IN (0, 1)),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- The register's hot path: one account, ordered by date (FR-13, NFR-1).
CREATE INDEX idx_transactions_account_date ON transactions(account_id, date);
-- E3's activity GROUP BY (category, month) leans on this.
CREATE INDEX idx_transactions_category_date ON transactions(category_id, date);
CREATE INDEX idx_transactions_payee ON transactions(payee_id);
