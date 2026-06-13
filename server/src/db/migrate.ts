import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

/**
 * Forward-only, ordered SQL-file migration runner (ADR-003, NFR-11).
 *
 * Migrations are plain .sql files in server/migrations/, applied in filename
 * order (zero-padded numeric prefix), each inside its own transaction, and
 * recorded in schema_migrations. Runs at boot BEFORE the HTTP server accepts
 * traffic (AC-2 of E1.S1). No down migrations by design.
 *
 * Note: ADR-003 also calls for a pre-migration backup and a balance checksum
 * bracket; those arrive with E7.S1/E7.S3 (backup command) — out of scope here.
 */

// Resolves to server/migrations both from src (tsx/vitest) and dist (production build).
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

/**
 * Migrations on disk that have not been applied yet (E7.S3: the boot bracket
 * decides whether a pre-migration backup + balance checksum are needed
 * BEFORE running anything). Safe on a brand-new database.
 */
export function listPendingMigrations(
  db: Database.Database,
  migrationsDir: string = MIGRATIONS_DIR,
): string[] {
  const hasTable =
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get() !== undefined;
  const appliedSet = new Set(
    hasTable
      ? (db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map(
          (r) => r.name,
        )
      : [],
  );
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((name) => !appliedSet.has(name));
}

export function runMigrations(db: Database.Database, migrationsDir: string = MIGRATIONS_DIR): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT;
  `);

  const available = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const appliedSet = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );

  const newlyApplied: string[] = [];
  for (const name of available) {
    if (appliedSet.has(name)) continue;
    const sql = readFileSync(join(migrationsDir, name), 'utf8');
    const applyOne = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name);
    });
    applyOne();
    newlyApplied.push(name);
  }
  return newlyApplied;
}
