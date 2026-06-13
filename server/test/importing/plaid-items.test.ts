import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { milliunits } from '@tyche/shared';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedSystemCategories } from '../../src/db/seed.js';
import { loadMasterKey } from '../../src/crypto/index.js';
import { createAccount } from '../../src/ledger/index.js';
import {
  applyAccountMappings,
  appendSyncLog,
  createLinkedItem,
  getAccessToken,
  getPlaidItem,
  ImportError,
  listAccountLinks,
  listPlaidItems,
  listSyncLog,
} from '../../src/importing/index.js';

/**
 * Plaid Item persistence (E5.S1, FR-20, ADR-007): LINKING → ACTIVE state
 * machine, token encryption at rest (NFR-3), per-bank-account mapping
 * decisions, and the FR-27 sync-health log.
 */

const masterKey = loadMasterKey({ MASTER_KEY: 'a'.repeat(64) });
const ACCESS_TOKEN = 'access-sandbox-11112222-3333-4444-5555-666677778888';

let db: Database.Database;
let chequingId: string;

function linkItem(plaidItemId = 'item-rbc-1') {
  return createLinkedItem(db, masterKey, {
    plaidItemId,
    accessToken: ACCESS_TOKEN,
    institutionName: 'RBC Royal Bank',
    accounts: [
      { plaidAccountId: 'pa-chq', name: 'Chequing', mask: '1234', type: 'depository', subtype: 'checking' },
      { plaidAccountId: 'pa-visa', name: 'Visa', mask: '9999', type: 'credit', subtype: 'credit card' },
    ],
  });
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  seedSystemCategories(db);
  chequingId = createAccount(db, {
    name: 'Chequing',
    type: 'chequing',
    startingBalanceMilliunits: milliunits(0),
    startingDate: '2026-01-01',
  }).id;
});
afterEach(() => db.close());

describe('createLinkedItem (S1 AC-1/AC-2)', () => {
  it('persists the Item in LINKING with a null cursor and its discovered accounts unmapped', () => {
    const item = linkItem();
    expect(item).toMatchObject({
      plaidItemId: 'item-rbc-1',
      institutionName: 'RBC Royal Bank',
      status: 'LINKING',
      cursor: null,
    });
    const links = listAccountLinks(db, item.id);
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.accountId).toBeNull();
      expect(link.skipped).toBe(false);
    }
    expect(listPlaidItems(db)).toHaveLength(1);
  });

  it('AC-2 (NFR-3, ADR-007): the access token is stored ONLY as an AES-256-GCM envelope — never plaintext', () => {
    const item = linkItem();
    const row = db
      .prepare('SELECT access_token_ciphertext FROM plaid_items WHERE id = ?')
      .get(item.id) as { access_token_ciphertext: string };
    expect(row.access_token_ciphertext.startsWith('v1.')).toBe(true);
    expect(row.access_token_ciphertext).not.toContain(ACCESS_TOKEN);
    // and the decrypt round-trip recovers it, server-side only
    expect(getAccessToken(db, masterKey, item.id)).toBe(ACCESS_TOKEN);
  });

  it('re-linking the same Plaid item replaces the token but keeps identity, cursor and mappings (S4 contract)', () => {
    const item = linkItem();
    applyAccountMappings(db, item.id, [
      { plaidAccountId: 'pa-chq', accountId: chequingId, skipped: false },
    ]);
    db.prepare("UPDATE plaid_items SET cursor = 'c42' WHERE id = ?").run(item.id);

    const again = createLinkedItem(db, masterKey, {
      plaidItemId: 'item-rbc-1',
      accessToken: 'access-sandbox-new-token-after-relink',
      institutionName: 'RBC Royal Bank',
      accounts: [],
    });
    expect(again.id).toBe(item.id); // same Item, not a second record
    expect(again.cursor).toBe('c42'); // cursor survives — no re-import storm
    expect(getAccessToken(db, masterKey, item.id)).toBe('access-sandbox-new-token-after-relink');
    const chq = listAccountLinks(db, item.id).find((l) => l.plaidAccountId === 'pa-chq');
    expect(chq?.accountId).toBe(chequingId); // mapping survives
    expect(listPlaidItems(db)).toHaveLength(1);
  });
});

describe('applyAccountMappings (S1 AC-3)', () => {
  it('maps and skips each discovered account individually and moves the Item LINKING → ACTIVE', () => {
    const item = linkItem();
    const links = applyAccountMappings(db, item.id, [
      { plaidAccountId: 'pa-chq', accountId: chequingId, skipped: false },
      { plaidAccountId: 'pa-visa', accountId: null, skipped: true },
    ]);
    expect(links.find((l) => l.plaidAccountId === 'pa-chq')).toMatchObject({
      accountId: chequingId,
      skipped: false,
    });
    expect(links.find((l) => l.plaidAccountId === 'pa-visa')).toMatchObject({
      accountId: null,
      skipped: true,
    });
    expect(getPlaidItem(db, item.id).status).toBe('ACTIVE');
  });

  it('rejects unknown plaid accounts and unknown app accounts atomically — nothing half-applies', () => {
    const item = linkItem();
    expect(() =>
      applyAccountMappings(db, item.id, [
        { plaidAccountId: 'pa-chq', accountId: chequingId, skipped: false },
        { plaidAccountId: 'pa-nope', accountId: null, skipped: true },
      ]),
    ).toThrow(ImportError);
    // the first (valid) mapping was rolled back with the bad one
    expect(listAccountLinks(db, item.id).find((l) => l.plaidAccountId === 'pa-chq')?.accountId).toBeNull();
    expect(getPlaidItem(db, item.id).status).toBe('LINKING');

    expect(() =>
      applyAccountMappings(db, item.id, [
        { plaidAccountId: 'pa-chq', accountId: 'not-an-account', skipped: false },
      ]),
    ).toThrow();
  });

  it('404s an unknown item', () => {
    expect(() => applyAccountMappings(db, 'nope', [])).toThrow(ImportError);
    expect(() => getPlaidItem(db, 'nope')).toThrow(ImportError);
  });
});

describe('sync-health log (FR-27, S2 AC-7)', () => {
  it('appends attempts and lists them newest first with counts and error codes', () => {
    const item = linkItem();
    appendSyncLog(db, item.id, { outcome: 'success', addedCount: 3, updatedCount: 1, removedCount: 0 });
    appendSyncLog(db, item.id, {
      outcome: 'error',
      errorCode: 'ITEM_LOGIN_REQUIRED',
      message: 'the login expired',
    });
    const log = listSyncLog(db, item.id);
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({
      outcome: 'error',
      errorCode: 'ITEM_LOGIN_REQUIRED',
      message: 'the login expired',
      addedCount: 0,
    });
    expect(log[1]).toMatchObject({ outcome: 'success', addedCount: 3, updatedCount: 1, errorCode: null });
    expect(typeof log[0]!.at).toBe('string');
  });
});
