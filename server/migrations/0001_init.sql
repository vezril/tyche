-- E1.S1 walking-skeleton schema (ADR-003, ADR-004).
-- Conventions, binding for every future migration:
--   * every table is STRICT (AC-6);
--   * monetary columns are INTEGER milliunits and named *_milliunits (ADR-004);
--   * forward-only: never edit an applied file, add a new one (NFR-11).

-- Key/value settings. E1.S1 uses it only as the durability-test placeholder
-- write (AC-3); E1.S3 builds the real settings surface on top.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- Category structure (architecture §5). Full management arrives in E3.S6;
-- the skeleton needs the tables to seed the two protected system categories (AC-7, FR-18).
CREATE TABLE category_groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  hidden     INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  is_system  INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1))
) STRICT;

CREATE TABLE categories (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES category_groups(id),
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  hidden     INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  -- Protected system categories (Inflow: Ready to Assign, Reconciliation
  -- adjustment) carry is_system = 1; category management must refuse to
  -- delete/hide/rename them (rule enforced in E3.S6 per AC-7).
  is_system  INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1))
) STRICT;

CREATE UNIQUE INDEX idx_categories_group_name ON categories(group_id, name);
