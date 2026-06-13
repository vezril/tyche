import { describe, expect, it, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  changePassword,
  createSession,
  createUser,
  destroyOtherSessions,
  validateSession,
  verifyLogin,
} from '../../src/auth/index.js';

// E1.S3 AC-5: password change requires the current password; the new argon2id
// hash replaces the old, and other sessions are invalidated.

describe('changePassword', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    runMigrations(db);
    await createUser(db, 'old-password-123');
  });

  it('replaces the hash when the current password is correct', async () => {
    expect(await changePassword(db, 'old-password-123', 'new-password-456')).toBe(true);
    expect(await verifyLogin(db, 'new-password-456')).toBe(true);
    expect(await verifyLogin(db, 'old-password-123')).toBe(false);
  });

  it('refuses and keeps the old hash when the current password is wrong', async () => {
    expect(await changePassword(db, 'WRONG', 'new-password-456')).toBe(false);
    expect(await verifyLogin(db, 'old-password-123')).toBe(true);
    expect(await verifyLogin(db, 'new-password-456')).toBe(false);
  });

  it('stores an argon2id hash, never the plaintext (NFR-10)', async () => {
    await changePassword(db, 'old-password-123', 'new-password-456');
    const row = db.prepare('SELECT password_hash FROM users WHERE id = 1').get() as {
      password_hash: string;
    };
    expect(row.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(row.password_hash).not.toContain('new-password-456');
  });
});

describe('destroyOtherSessions (AC-5: existing other sessions are invalidated)', () => {
  it('keeps only the given session', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    const now = new Date('2026-06-12T12:00:00Z');
    const keep = createSession(db, now);
    const other1 = createSession(db, now);
    const other2 = createSession(db, now);

    destroyOtherSessions(db, keep);

    expect(validateSession(db, keep, now)).toBe(true);
    expect(validateSession(db, other1, now)).toBe(false);
    expect(validateSession(db, other2, now)).toBe(false);
  });
});
