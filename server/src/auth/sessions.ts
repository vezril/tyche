import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getSetting } from '../admin/settings.js';

/**
 * Server-side session store in SQLite (ADR-008, AC-3 of E1.S2).
 *
 * Opaque 256-bit ids; the cookie carries nothing else. Idle expiry is read at
 * validation time from the settings table — the key is owned by E1.S3 (which
 * adds the settings UI); this module only consumes it with the 30-day default.
 * All functions take `now` explicitly so tests inject a clock instead of
 * sleeping.
 */

/** Settings key E1.S3 exposes in the UI. Value: idle expiry in whole days. */
export const IDLE_EXPIRY_SETTING_KEY = 'session_idle_expiry_days';
export const DEFAULT_IDLE_EXPIRY_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export function idleExpiryDays(db: Database.Database): number {
  const raw = getSetting(db, IDLE_EXPIRY_SETTING_KEY)?.value;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_IDLE_EXPIRY_DAYS;
}

export function createSession(db: Database.Database, now: Date): string {
  const id = randomBytes(32).toString('base64url');
  const iso = now.toISOString();
  db.prepare('INSERT INTO sessions (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
    id,
    iso,
    iso,
  );
  return id;
}

/**
 * True iff the session exists and has been seen within the idle window.
 * Valid sessions are touched (sliding window); expired ones are deleted.
 */
export function validateSession(db: Database.Database, id: string, now: Date): boolean {
  const row = db.prepare('SELECT last_seen_at FROM sessions WHERE id = ?').get(id) as
    | { last_seen_at: string }
    | undefined;
  if (!row) return false;

  const idleMs = now.getTime() - new Date(row.last_seen_at).getTime();
  if (idleMs > idleExpiryDays(db) * DAY_MS) {
    destroySession(db, id);
    return false;
  }
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now.toISOString(), id);
  return true;
}

export function destroySession(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

/** Revoke every session except `keepId` (E1.S3 AC-5: password change). */
export function destroyOtherSessions(db: Database.Database, keepId: string): void {
  db.prepare('DELETE FROM sessions WHERE id <> ?').run(keepId);
}
