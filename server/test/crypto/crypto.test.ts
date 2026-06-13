import { describe, expect, it } from 'vitest';
import {
  decryptField,
  encryptField,
  keyId,
  loadMasterKey,
  MASTER_KEY_HINT,
} from '../../src/crypto/index.js';

// E1.S3 / ADR-007: AES-256-GCM field encryption at the persistence boundary.
// The envelope is a versioned opaque string carrying key id + nonce + tag, so
// SQLite stores ciphertext only and key rotation stays possible later.

const HEX_KEY = 'a'.repeat(64); // 32 bytes
const OTHER_HEX_KEY = 'b'.repeat(64);

describe('loadMasterKey (ADR-007: 256-bit key from .env)', () => {
  it('accepts a 64-char hex MASTER_KEY', () => {
    const key = loadMasterKey({ MASTER_KEY: HEX_KEY });
    expect(key.length).toBe(32);
    expect(key.toString('hex')).toBe(HEX_KEY);
  });

  it('accepts a base64 MASTER_KEY decoding to 32 bytes', () => {
    const raw = Buffer.alloc(32, 7);
    const key = loadMasterKey({ MASTER_KEY: raw.toString('base64') });
    expect(key.equals(raw)).toBe(true);
  });

  it('fails clearly when MASTER_KEY is missing', () => {
    expect(() => loadMasterKey({})).toThrowError(/MASTER_KEY/);
  });

  it('fails clearly when MASTER_KEY is empty (the shipped .env.example default)', () => {
    expect(() => loadMasterKey({ MASTER_KEY: '' })).toThrowError(/MASTER_KEY/);
  });

  it('fails clearly when MASTER_KEY is malformed (wrong length)', () => {
    expect(() => loadMasterKey({ MASTER_KEY: 'deadbeef' })).toThrowError(/32 bytes/);
  });

  it('the error message tells the user how to generate a key (first-run docs)', () => {
    expect(() => loadMasterKey({})).toThrowError(MASTER_KEY_HINT);
    expect(MASTER_KEY_HINT).toMatch(/openssl rand -hex 32/);
  });
});

describe('encryptField / decryptField (AES-256-GCM envelope)', () => {
  const key = loadMasterKey({ MASTER_KEY: HEX_KEY });

  it('round-trips a string', () => {
    const blob = encryptField(key, 'plaid-secret-sandbox-abc123');
    expect(decryptField(key, blob)).toBe('plaid-secret-sandbox-abc123');
  });

  it('round-trips empty and unicode strings', () => {
    expect(decryptField(key, encryptField(key, ''))).toBe('');
    expect(decryptField(key, encryptField(key, 'ünïcødé ✓ 密钥'))).toBe('ünïcødé ✓ 密钥');
  });

  it('produces a versioned envelope carrying the key id (rotation hook, ADR-007)', () => {
    const blob = encryptField(key, 'x');
    expect(blob.startsWith(`v1.${keyId(key)}.`)).toBe(true);
  });

  it('never contains the plaintext in the envelope', () => {
    const blob = encryptField(key, 'super-secret-value');
    expect(blob).not.toContain('super-secret-value');
  });

  it('uses a random nonce per value: same plaintext encrypts differently', () => {
    expect(encryptField(key, 'same')).not.toBe(encryptField(key, 'same'));
  });

  it('rejects tampered ciphertext (GCM auth tag)', () => {
    const blob = encryptField(key, 'integrity-matters');
    const parts = blob.split('.');
    const ct = parts[4]!;
    const flipped = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
    const tampered = [...parts.slice(0, 4), flipped].join('.');
    expect(() => decryptField(key, tampered)).toThrowError();
  });

  it('rejects decryption with the wrong key, naming the key-id mismatch', () => {
    const other = loadMasterKey({ MASTER_KEY: OTHER_HEX_KEY });
    const blob = encryptField(key, 'x');
    expect(() => decryptField(other, blob)).toThrowError(/key/i);
  });

  it('rejects an unrecognized envelope', () => {
    expect(() => decryptField(key, 'not-an-envelope')).toThrowError(/envelope/i);
  });
});
