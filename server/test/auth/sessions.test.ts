import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { setSetting } from '../../src/admin/settings.js';
import {
  createSession,
  destroySession,
  IDLE_EXPIRY_SETTING_KEY,
  idleExpiryDays,
  validateSession,
} from '../../src/auth/sessions.js';

// E1.S2 AC-3: opaque session ids stored in SQLite, idle expiry read from the
// E1.S3-owned setting (default 30 days), never hard-coded. Clock is injected —
// no sleeping.

const DAY_MS = 24 * 60 * 60 * 1000;

describe('auth sessions', () => {
  let db: Database.Database;
  const t0 = new Date('2026-06-12T00:00:00.000Z');

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db);
  });
  afterEach(() => {
    db.close();
  });

  it('createSession returns an opaque id and persists the row in SQLite', () => {
    const id = createSession(db, t0);
    expect(id.length).toBeGreaterThanOrEqual(32); // ≥ 192 bits of entropy, base64url
    const row = db.prepare('SELECT id FROM sessions WHERE id = ?').get(id);
    expect(row).toBeDefined();
  });

  it('session ids are unique per login', () => {
    expect(createSession(db, t0)).not.toBe(createSession(db, t0));
  });

  it('a fresh session validates', () => {
    const id = createSession(db, t0);
    expect(validateSession(db, id, t0)).toBe(true);
  });

  it('an unknown id does not validate', () => {
    expect(validateSession(db, 'no-such-session', t0)).toBe(false);
  });

  it('idle expiry defaults to 30 days when the setting is absent (AC-3)', () => {
    expect(idleExpiryDays(db)).toBe(30);
    const id = createSession(db, t0);
    expect(validateSession(db, id, new Date(t0.getTime() + 29 * DAY_MS))).toBe(true);
    const id2 = createSession(db, t0);
    expect(validateSession(db, id2, new Date(t0.getTime() + 31 * DAY_MS))).toBe(false);
  });

  it('idle expiry honors the configured setting, not a hard-coded value (AC-3)', () => {
    setSetting(db, IDLE_EXPIRY_SETTING_KEY, '1');
    expect(idleExpiryDays(db)).toBe(1);
    const id = createSession(db, t0);
    expect(validateSession(db, id, new Date(t0.getTime() + 2 * DAY_MS))).toBe(false);
  });

  it('an invalid setting value falls back to the 30-day default', () => {
    setSetting(db, IDLE_EXPIRY_SETTING_KEY, 'not-a-number');
    expect(idleExpiryDays(db)).toBe(30);
  });

  it('activity slides the idle window (touch on validate)', () => {
    setSetting(db, IDLE_EXPIRY_SETTING_KEY, '10');
    const id = createSession(db, t0);
    // touch every 7 days — each within the 10-day window
    expect(validateSession(db, id, new Date(t0.getTime() + 7 * DAY_MS))).toBe(true);
    expect(validateSession(db, id, new Date(t0.getTime() + 14 * DAY_MS))).toBe(true);
    // ... so 14 days after creation it is still valid, but 11 idle days kills it
    expect(validateSession(db, id, new Date(t0.getTime() + 25 * DAY_MS))).toBe(false);
  });

  it('an expired session is deleted from the store', () => {
    setSetting(db, IDLE_EXPIRY_SETTING_KEY, '1');
    const id = createSession(db, t0);
    validateSession(db, id, new Date(t0.getTime() + 2 * DAY_MS));
    expect(db.prepare('SELECT id FROM sessions WHERE id = ?').get(id)).toBeUndefined();
  });

  it('destroySession revokes server-side (logout)', () => {
    const id = createSession(db, t0);
    destroySession(db, id);
    expect(validateSession(db, id, t0)).toBe(false);
  });
});
