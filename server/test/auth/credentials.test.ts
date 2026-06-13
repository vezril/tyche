import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  createUser,
  hashPassword,
  userExists,
  verifyLogin,
  verifyPassword,
} from '../../src/auth/credentials.js';

// E1.S2 AC-1 (single account created once) and AC-5 (argon2id hash, no plaintext).

describe('auth credentials', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db);
  });
  afterEach(() => {
    db.close();
  });

  it('hashPassword produces an argon2id hash, never the plaintext (AC-5)', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain('correct horse battery staple');
  });

  it('verifyPassword accepts the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('s3cret-pw');
    await expect(verifyPassword(hash, 's3cret-pw')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'wrong-pw')).resolves.toBe(false);
  });

  it('userExists is false on a fresh database (first-run, AC-1)', () => {
    expect(userExists(db)).toBe(false);
  });

  it('createUser stores exactly one account with an argon2id hash (AC-1, AC-5)', async () => {
    await createUser(db, 'hunter2hunter2');
    expect(userExists(db)).toBe(true);
    const row = db.prepare('SELECT id, password_hash FROM users').get() as {
      id: number;
      password_hash: string;
    };
    expect(row.id).toBe(1);
    expect(row.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(row.password_hash).not.toContain('hunter2hunter2');
  });

  it('createUser refuses a second account (single user, AC-1)', async () => {
    await createUser(db, 'first-password');
    await expect(createUser(db, 'second-password')).rejects.toThrow(/exists/i);
  });

  it('verifyLogin checks the stored credential', async () => {
    await createUser(db, 'right-password');
    await expect(verifyLogin(db, 'right-password')).resolves.toBe(true);
    await expect(verifyLogin(db, 'wrong-password')).resolves.toBe(false);
  });

  it('verifyLogin is false when no user exists yet', async () => {
    await expect(verifyLogin(db, 'anything')).resolves.toBe(false);
  });
});
