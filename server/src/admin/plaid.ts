import type Database from 'better-sqlite3';
import { decryptField, encryptField } from '../crypto/index.js';
import { getSetting, setSetting } from './settings.js';

/**
 * Plaid credentials (E1.S3 AC-1/AC-2/AC-6, FR-34, NFR-3, ADR-007).
 *
 * The client id is not a secret and lives in the plain settings table; the
 * client secret is encrypted with the master key and lives in the separate
 * credentials table, which no generic API route can read. The secret is
 * WRITE-ONLY at the API boundary: status reports configured/not-configured
 * and the client id, never the secret. Only the Plaid client (E5) reads the
 * secret back, server-side, via getPlaidSecret.
 */

export const PLAID_CLIENT_ID_SETTING_KEY = 'plaid_client_id';
export const PLAID_SECRET_CREDENTIAL_NAME = 'plaid_secret';
export const PLAID_ENV_SETTING_KEY = 'plaid_env';

/**
 * Which Plaid environment the client talks to (E5.S1). A plain setting (not a
 * secret): the settings KV route can flip it at runtime; the PLAID_ENV env
 * var seeds/overrides nothing once a setting exists. Defaults to sandbox —
 * production is an explicit, deliberate step (OQ-2 gate).
 */
export function getPlaidEnvironment(
  db: Database.Database,
  env: Record<string, string | undefined> = {},
): 'sandbox' | 'production' {
  const value = getSetting(db, PLAID_ENV_SETTING_KEY)?.value ?? env['PLAID_ENV'];
  return value === 'production' ? 'production' : 'sandbox';
}

export interface PlaidCredentialsStatus {
  configured: boolean;
  clientId: string | null;
}

function getCredential(db: Database.Database, name: string): string | undefined {
  const row = db.prepare('SELECT value FROM credentials WHERE name = ?').get(name) as
    | { value: string }
    | undefined;
  return row?.value;
}

function setCredential(db: Database.Database, name: string, envelope: string): void {
  db.prepare(
    `INSERT INTO credentials (name, value) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET
       value = excluded.value,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).run(name, envelope);
}

export function setPlaidCredentials(
  db: Database.Database,
  masterKey: Buffer,
  clientId: string,
  secret: string,
): void {
  const write = db.transaction(() => {
    setSetting(db, PLAID_CLIENT_ID_SETTING_KEY, clientId);
    setCredential(db, PLAID_SECRET_CREDENTIAL_NAME, encryptField(masterKey, secret));
  });
  write();
}

export function clearPlaidCredentials(db: Database.Database): void {
  const clear = db.transaction(() => {
    db.prepare('DELETE FROM settings WHERE key = ?').run(PLAID_CLIENT_ID_SETTING_KEY);
    db.prepare('DELETE FROM credentials WHERE name = ?').run(PLAID_SECRET_CREDENTIAL_NAME);
  });
  clear();
}

export function getPlaidCredentialsStatus(db: Database.Database): PlaidCredentialsStatus {
  const configured = getCredential(db, PLAID_SECRET_CREDENTIAL_NAME) !== undefined;
  return {
    configured,
    clientId: configured ? (getSetting(db, PLAID_CLIENT_ID_SETTING_KEY)?.value ?? null) : null,
  };
}

/** Server-side only (E5 Plaid client). NEVER expose through an API response or log. */
export function getPlaidSecret(db: Database.Database, masterKey: Buffer): string | undefined {
  const envelope = getCredential(db, PLAID_SECRET_CREDENTIAL_NAME);
  return envelope === undefined ? undefined : decryptField(masterKey, envelope);
}

/**
 * AC-6: PLAID_CLIENT_ID/PLAID_SECRET in .env seed the settings at boot as an
 * alternative to UI entry. Credentials already saved (e.g. via the UI) win —
 * seeding never overwrites. Returns true iff it seeded.
 */
export function seedPlaidCredentialsFromEnv(
  db: Database.Database,
  masterKey: Buffer,
  env: Record<string, string | undefined>,
): boolean {
  const clientId = env['PLAID_CLIENT_ID']?.trim();
  const secret = env['PLAID_SECRET']?.trim();
  if (!clientId || !secret) return false;
  if (getPlaidCredentialsStatus(db).configured) return false;
  setPlaidCredentials(db, masterKey, clientId, secret);
  return true;
}
