import type Database from 'better-sqlite3';

/**
 * admin module (ADR-001): settings, backup/restore, export, consistency check.
 *
 * E1.S1 ships only the placeholder key/value setting used by the AC-3
 * durability test; the real settings surface (Plaid creds, sync interval,
 * password change) is E1.S3.
 */

export interface Setting {
  key: string;
  value: string;
}

export function setSetting(db: Database.Database, key: string, value: string): Setting {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).run(key, value);
  return { key, value };
}

export function getSetting(db: Database.Database, key: string): Setting | undefined {
  const row = db.prepare('SELECT key, value FROM settings WHERE key = ?').get(key) as
    | { key: string; value: string }
    | undefined;
  return row;
}

// --- Polling schedule (E1.S3 AC-4, FR-34) ----------------------------------
// Stored + validated here; consumed by the E5.S3 scheduler.

export const POLLING_INTERVAL_SETTING_KEY = 'polling_interval_hours';
export const DEFAULT_POLLING_INTERVAL_HOURS = 6;
export const MIN_POLLING_INTERVAL_HOURS = 1;
export const MAX_POLLING_INTERVAL_HOURS = 24;

export function getPollingIntervalHours(db: Database.Database): number {
  const raw = getSetting(db, POLLING_INTERVAL_SETTING_KEY)?.value;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(parsed) &&
    parsed >= MIN_POLLING_INTERVAL_HOURS &&
    parsed <= MAX_POLLING_INTERVAL_HOURS
    ? parsed
    : DEFAULT_POLLING_INTERVAL_HOURS;
}

export function setPollingIntervalHours(db: Database.Database, hours: number): void {
  if (
    !Number.isInteger(hours) ||
    hours < MIN_POLLING_INTERVAL_HOURS ||
    hours > MAX_POLLING_INTERVAL_HOURS
  ) {
    throw new RangeError(
      `polling interval must be an integer between ${MIN_POLLING_INTERVAL_HOURS} and ${MAX_POLLING_INTERVAL_HOURS} hours`,
    );
  }
  setSetting(db, POLLING_INTERVAL_SETTING_KEY, String(hours));
}
