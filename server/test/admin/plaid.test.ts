import { describe, expect, it, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { loadMasterKey } from '../../src/crypto/index.js';
import {
  clearPlaidCredentials,
  getPlaidCredentialsStatus,
  getPlaidSecret,
  seedPlaidCredentialsFromEnv,
  setPlaidCredentials,
} from '../../src/admin/plaid.js';

// E1.S3 AC-1/AC-2/AC-6: Plaid credentials — client id plain, secret encrypted
// at rest via the crypto module (ADR-007). The secret is write-only: status
// never includes it; only the Plaid client (E5) reads it back via getPlaidSecret.

const key = loadMasterKey({ MASTER_KEY: 'c'.repeat(64) });

describe('plaid credentials store', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db);
  });

  it('reports not-configured before any save', () => {
    expect(getPlaidCredentialsStatus(db)).toEqual({ configured: false, clientId: null });
  });

  it('stores credentials and reports configured with the client id only (AC-1)', () => {
    setPlaidCredentials(db, key, 'client-id-123', 'sandbox-secret-xyz');
    const status = getPlaidCredentialsStatus(db);
    expect(status).toEqual({ configured: true, clientId: 'client-id-123' });
    expect(JSON.stringify(status)).not.toContain('sandbox-secret-xyz');
  });

  it('round-trips the secret for the Plaid client (E5 seam)', () => {
    setPlaidCredentials(db, key, 'client-id-123', 'sandbox-secret-xyz');
    expect(getPlaidSecret(db, key)).toBe('sandbox-secret-xyz');
  });

  it('persists only AES-256-GCM ciphertext in the credentials row (AC-2)', () => {
    setPlaidCredentials(db, key, 'client-id-123', 'sandbox-secret-xyz');
    const row = db
      .prepare('SELECT value FROM credentials WHERE name = ?')
      .get('plaid_secret') as { value: string };
    expect(row.value.startsWith('v1.')).toBe(true);
    expect(row.value).not.toContain('sandbox-secret-xyz');
  });

  it('keeps the secret out of the settings table (generic settings API cannot reach it)', () => {
    setPlaidCredentials(db, key, 'client-id-123', 'sandbox-secret-xyz');
    const rows = db.prepare('SELECT key, value FROM settings').all();
    expect(JSON.stringify(rows)).not.toContain('sandbox-secret-xyz');
  });

  it('replaces credentials on a second save', () => {
    setPlaidCredentials(db, key, 'old-client', 'old-secret');
    setPlaidCredentials(db, key, 'new-client', 'new-secret');
    expect(getPlaidCredentialsStatus(db).clientId).toBe('new-client');
    expect(getPlaidSecret(db, key)).toBe('new-secret');
  });

  it('clears credentials back to not-configured', () => {
    setPlaidCredentials(db, key, 'client-id-123', 'sandbox-secret-xyz');
    clearPlaidCredentials(db);
    expect(getPlaidCredentialsStatus(db)).toEqual({ configured: false, clientId: null });
    expect(getPlaidSecret(db, key)).toBeUndefined();
  });

  describe('seedPlaidCredentialsFromEnv (AC-6: .env alternative to UI entry)', () => {
    it('seeds from PLAID_CLIENT_ID/PLAID_SECRET when not configured', () => {
      const seeded = seedPlaidCredentialsFromEnv(db, key, {
        PLAID_CLIENT_ID: 'env-client',
        PLAID_SECRET: 'env-secret',
      });
      expect(seeded).toBe(true);
      expect(getPlaidCredentialsStatus(db)).toEqual({ configured: true, clientId: 'env-client' });
      expect(getPlaidSecret(db, key)).toBe('env-secret');
    });

    it('does not overwrite credentials already saved via the UI', () => {
      setPlaidCredentials(db, key, 'ui-client', 'ui-secret');
      const seeded = seedPlaidCredentialsFromEnv(db, key, {
        PLAID_CLIENT_ID: 'env-client',
        PLAID_SECRET: 'env-secret',
      });
      expect(seeded).toBe(false);
      expect(getPlaidCredentialsStatus(db).clientId).toBe('ui-client');
      expect(getPlaidSecret(db, key)).toBe('ui-secret');
    });

    it('is a no-op when the env vars are absent or blank', () => {
      expect(seedPlaidCredentialsFromEnv(db, key, {})).toBe(false);
      expect(seedPlaidCredentialsFromEnv(db, key, { PLAID_CLIENT_ID: 'only-id' })).toBe(false);
      expect(seedPlaidCredentialsFromEnv(db, key, { PLAID_CLIENT_ID: '', PLAID_SECRET: '' })).toBe(
        false,
      );
      expect(getPlaidCredentialsStatus(db).configured).toBe(false);
    });
  });
});
