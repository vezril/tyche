import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * crypto module (ADR-007, E1.S3): AES-256-GCM field encryption at the
 * persistence boundary. SQLite stores only the opaque envelope produced here;
 * the 256-bit master key lives in `.env` (MASTER_KEY) and is never written to
 * the database, logs, or backups.
 *
 * Envelope format (versioned, dot-separated):
 *   v1.<keyId>.<iv b64url>.<tag b64url>.<ciphertext b64url>
 * The key id (a short fingerprint of the key) enables future rotation
 * (re-encrypt rows, bump key id) without re-linking — ADR-007.
 *
 * This module is reused by E5.S1 to encrypt Plaid access tokens, so it sits
 * outside the admin module (importing may not import admin per ADR-001).
 */

export const MASTER_KEY_HINT =
  'generate one with: openssl rand -hex 32 — then set MASTER_KEY= in .env (see README first-run setup)';

const KEY_BYTES = 32;
const IV_BYTES = 12; // 96-bit nonce, the GCM-recommended size
const VERSION = 'v1';

/**
 * Parse MASTER_KEY from the environment: 64 hex chars or base64/base64url
 * decoding to exactly 32 bytes. Throws a clear, actionable error otherwise —
 * the app must fail to start rather than run without encryption (E1.S3).
 */
export function loadMasterKey(env: Record<string, string | undefined>): Buffer {
  const raw = env['MASTER_KEY']?.trim();
  if (!raw) {
    throw new Error(`MASTER_KEY is not set in the environment (.env) — ${MASTER_KEY_HINT}`);
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  if (/^[A-Za-z0-9+/_-]{43}={0,2}$/.test(raw)) {
    const b64 = Buffer.from(raw, 'base64');
    if (b64.length === KEY_BYTES) return b64;
  }
  throw new Error(
    `MASTER_KEY is malformed: expected 32 bytes as 64 hex chars or base64 — ${MASTER_KEY_HINT}`,
  );
}

/** Short non-secret fingerprint of a key, stored in the envelope for rotation. */
export function keyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

/** Encrypt a UTF-8 string to the versioned opaque envelope (random nonce per call). */
export function encryptField(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    keyId(key),
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/** Decrypt an envelope produced by {@link encryptField}. Throws on tampering or wrong key. */
export function decryptField(key: Buffer, envelope: string): string {
  const parts = envelope.split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new Error(`unrecognized ciphertext envelope (expected ${VERSION}.<keyId>.<iv>.<tag>.<ct>)`);
  }
  const [, envelopeKeyId, ivPart, tagPart, ctPart] = parts as [string, string, string, string, string];
  if (envelopeKeyId !== keyId(key)) {
    throw new Error(
      `ciphertext was encrypted with key id ${envelopeKeyId}, but the loaded MASTER_KEY has key id ${keyId(key)}`,
    );
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
