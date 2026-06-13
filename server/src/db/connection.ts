import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

/**
 * Open the single SQLite connection (one writer by construction, ADR-003).
 *
 * Durability posture per ADR-003 / NFR-7: WAL journal + synchronous=FULL means
 * an acknowledged commit survives kill -9 and power loss. foreign_keys=ON is
 * per-connection in SQLite, so it is set here, the only place connections are made.
 */
export function openDatabase(path: string): Database.Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  return db;
}
