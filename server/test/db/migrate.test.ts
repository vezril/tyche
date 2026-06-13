import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { MIGRATIONS_DIR, runMigrations } from '../../src/db/migrate.js';
import type BetterSqlite3 from 'better-sqlite3';

// ADR-003 / AC-2: forward-only, ordered SQL-file migrations recorded in schema_migrations,
// run automatically at boot before the HTTP server accepts traffic.

describe('runMigrations (ordered SQL-file runner)', () => {
  let dir: string;
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ynab-mig-'));
    db = openDatabase(join(dir, 'app.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeFixtureMigrations(migrationsDir: string): void {
    writeFileSync(
      join(migrationsDir, '0001_one.sql'),
      'CREATE TABLE t1 (id INTEGER PRIMARY KEY) STRICT;',
    );
    writeFileSync(
      join(migrationsDir, '0002_two.sql'),
      "INSERT INTO t1 (id) VALUES (42);",
    );
  }

  it('applies pending migrations in filename order and records them', () => {
    writeFixtureMigrations(dir);
    const applied = runMigrations(db, dir);
    expect(applied).toEqual(['0001_one.sql', '0002_two.sql']);
    const rows = db.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as {
      name: string;
    }[];
    expect(rows.map((r) => r.name)).toEqual(['0001_one.sql', '0002_two.sql']);
    expect(db.prepare('SELECT id FROM t1').get()).toEqual({ id: 42 });
  });

  it('is idempotent: a second run applies nothing', () => {
    writeFixtureMigrations(dir);
    runMigrations(db, dir);
    expect(runMigrations(db, dir)).toEqual([]);
  });

  it('applies only migrations newer than those recorded', () => {
    writeFixtureMigrations(dir);
    runMigrations(db, dir);
    writeFileSync(join(dir, '0003_three.sql'), 'CREATE TABLE t3 (id INTEGER PRIMARY KEY) STRICT;');
    expect(runMigrations(db, dir)).toEqual(['0003_three.sql']);
  });

  it('rolls back a failing migration atomically and does not record it', () => {
    writeFileSync(
      join(dir, '0001_bad.sql'),
      'CREATE TABLE good (id INTEGER PRIMARY KEY) STRICT;\nTHIS IS NOT SQL;',
    );
    expect(() => runMigrations(db, dir)).toThrow();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'good'")
      .all();
    expect(tables).toEqual([]);
    const recorded = db.prepare('SELECT name FROM schema_migrations').all();
    expect(recorded).toEqual([]);
  });
});

describe('real migrations (server/migrations)', () => {
  let dir: string;
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ynab-real-mig-'));
    db = openDatabase(join(dir, 'app.db'));
    runMigrations(db, MIGRATIONS_DIR);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the skeleton schema', () => {
    const names = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toContain('settings');
    expect(names).toContain('category_groups');
    expect(names).toContain('categories');
    expect(names).toContain('schema_migrations');
  });

  it('declares every application table STRICT (AC-6, ADR-003)', () => {
    const rows = db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { name: string; sql: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.sql, `${row.name} must be STRICT`).toMatch(/\bSTRICT\b/);
    }
  });

  it('has no non-INTEGER monetary columns (AC-6, ADR-004)', () => {
    // Naming convention: monetary columns end in _milliunits and must be INTEGER.
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { name: string }[];
    for (const { name } of tables) {
      const cols = db.pragma(`table_info(${name})`) as { name: string; type: string }[];
      for (const col of cols) {
        expect(['REAL', 'BLOB'].includes(col.type), `${name}.${col.name} must not be ${col.type}`).toBe(false);
        if (col.name.endsWith('_milliunits')) {
          expect(col.type, `${name}.${col.name} must be INTEGER milliunits`).toBe('INTEGER');
        }
      }
    }
  });
});
