-- E1.S2 authentication schema (FR-33, NFR-10, ADR-008).
-- Single user account + server-side session store in SQLite.

-- The single account (NG-1: no multi-user). id is pinned to 1 so a second
-- INSERT violates the primary key — single-user enforced by the schema.
CREATE TABLE users (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL, -- argon2id PHC string (NFR-10); never plaintext
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- Server-side sessions (ADR-008): opaque id lives in the HttpOnly cookie,
-- the record lives here so sessions survive restarts and logout can revoke.
-- Idle expiry is computed at validation time from the settings table
-- (key 'session_idle_expiry_days', default 30 — owned by E1.S3), so the
-- duration stays configurable without a schema change.
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
) STRICT;
