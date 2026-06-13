-- E3.S1 budget engine: monthly assignments (FR-1, FR-4, architecture §5).
--
-- MonthAssignment is the ONLY stored budget input besides transactions
-- (ADR-005). Everything else — activity, carryover, available, RTA — is
-- recomputed on read; there are no aggregate tables to maintain, by design.
--
-- Conventions per 0001: STRICT, INTEGER milliunits named *_milliunits
-- (ADR-004), forward-only.

CREATE TABLE month_assignments (
  category_id         TEXT NOT NULL REFERENCES categories(id),
  -- Budget month as 'YYYY-MM'; lexicographic order == chronological order.
  month               TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  -- Signed: negative assignments are allowed (FR-4 unassign/adjust).
  assigned_milliunits INTEGER NOT NULL,
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (category_id, month)
) STRICT;

-- The engine's per-month totals and month-bounds scans.
CREATE INDEX idx_month_assignments_month ON month_assignments(month);
