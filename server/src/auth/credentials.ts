import argon2 from 'argon2';
import type Database from 'better-sqlite3';

/**
 * Single-account credential storage (FR-33, NFR-10, ADR-008 / E1.S2).
 *
 * The password is hashed with argon2id (AC-5); the plaintext is never
 * persisted or logged. The users table pins id = 1, so the schema itself
 * enforces the single account (NG-1).
 */

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

export function userExists(db: Database.Database): boolean {
  return db.prepare('SELECT 1 FROM users WHERE id = 1').get() !== undefined;
}

export async function createUser(db: Database.Database, password: string): Promise<void> {
  if (userExists(db)) {
    throw new Error('account already exists — setup is permanently unavailable (AC-1)');
  }
  const hash = await hashPassword(password);
  db.prepare('INSERT INTO users (id, password_hash) VALUES (1, ?)').run(hash);
}

/**
 * Change the password (E1.S3 AC-5): requires the current password; on success
 * the new argon2id hash replaces the old. Session invalidation is the
 * caller's job (destroyOtherSessions) so the active session can be kept.
 */
export async function changePassword(
  db: Database.Database,
  currentPassword: string,
  newPassword: string,
): Promise<boolean> {
  if (!(await verifyLogin(db, currentPassword))) return false;
  const hash = await hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = 1').run(hash);
  return true;
}

export async function verifyLogin(db: Database.Database, password: string): Promise<boolean> {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = 1').get() as
    | { password_hash: string }
    | undefined;
  if (!row) return false;
  return verifyPassword(row.password_hash, password);
}
