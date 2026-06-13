import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  INFLOW_READY_TO_ASSIGN_CATEGORY_ID,
  RECONCILIATION_ADJUSTMENT_CATEGORY_ID,
  seedSystemCategories,
} from '../../src/db/seed.js';
import type BetterSqlite3 from 'better-sqlite3';

// AC-7 (FR-18, architecture §5): first-run initialization seeds the two protected
// system categories after migrations complete. Idempotent across reboots.

describe('seedSystemCategories', () => {
  let dir: string;
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tyche-seed-'));
    db = openDatabase(join(dir, 'app.db'));
    runMigrations(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function systemCategories(): { id: string; name: string; is_system: number }[] {
    return db
      .prepare('SELECT id, name, is_system FROM categories WHERE is_system = 1 ORDER BY name')
      .all() as { id: string; name: string; is_system: number }[];
  }

  it('seeds exactly the two protected system categories', () => {
    seedSystemCategories(db);
    expect(systemCategories()).toEqual([
      { id: INFLOW_READY_TO_ASSIGN_CATEGORY_ID, name: 'Inflow: Ready to Assign', is_system: 1 },
      {
        id: RECONCILIATION_ADJUSTMENT_CATEGORY_ID,
        name: 'Reconciliation adjustment',
        is_system: 1,
      },
    ]);
  });

  it('places them in a hidden system group', () => {
    seedSystemCategories(db);
    const group = db
      .prepare(
        `SELECT g.hidden, g.is_system FROM category_groups g
         JOIN categories c ON c.group_id = g.id
         WHERE c.id = ?`,
      )
      .get(INFLOW_READY_TO_ASSIGN_CATEGORY_ID) as { hidden: number; is_system: number };
    expect(group).toEqual({ hidden: 1, is_system: 1 });
  });

  it('is idempotent: reseeding adds nothing and overwrites nothing', () => {
    seedSystemCategories(db);
    seedSystemCategories(db);
    expect(systemCategories()).toHaveLength(2);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM category_groups').get() as { n: number }).n,
    ).toBe(1);
  });
});
