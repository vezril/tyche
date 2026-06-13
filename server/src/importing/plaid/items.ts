import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { decryptField, encryptField } from '../../crypto/index.js';
import { getAccountRow } from '../../ledger/index.js';
import { ImportError } from '../errors.js';
import { PlaidApiError, type PlaidClientPort, type PlaidDiscoveredAccount } from './client.js';

/**
 * Plaid Item persistence (E5.S1, FR-20, ADR-007): the LINKING → ACTIVE leg of
 * the Item state machine, plus the per-Item sync-health log (FR-27).
 *
 * The access token is encrypted with the crypto module's AES-256-GCM envelope
 * BEFORE it touches SQLite and decrypted only transiently for an API call —
 * it never appears in an API response, and the logger's redaction layer
 * (web/app.ts) censors `accessToken` fields besides (NFR-3).
 */

export type PlaidItemStatus = 'LINKING' | 'ACTIVE' | 'NEEDS_RELINK' | 'UNLINKED';

export interface PlaidItemRecord {
  id: string;
  plaidItemId: string;
  institutionName: string | null;
  status: PlaidItemStatus;
  /** null until the first successfully applied sync page (S2 AC-5). */
  cursor: string | null;
  createdAt: string;
}

export interface PlaidAccountLink {
  id: string;
  plaidAccountId: string;
  name: string;
  mask: string | null;
  type: string;
  subtype: string | null;
  /** Mapped app account, or null when unmapped/skipped (S1 AC-3). */
  accountId: string | null;
  skipped: boolean;
}

export interface PlaidSyncLogEntry {
  at: string;
  outcome: 'success' | 'error';
  addedCount: number;
  updatedCount: number;
  removedCount: number;
  errorCode: string | null;
  message: string | null;
}

interface ItemRow {
  id: string;
  plaid_item_id: string;
  institution_name: string | null;
  access_token_ciphertext: string;
  cursor: string | null;
  status: PlaidItemStatus;
  created_at: string;
}

interface LinkRow {
  id: string;
  plaid_account_id: string;
  name: string;
  mask: string | null;
  type: string;
  subtype: string | null;
  account_id: string | null;
  skipped: number;
}

function toRecord(row: ItemRow): PlaidItemRecord {
  return {
    id: row.id,
    plaidItemId: row.plaid_item_id,
    institutionName: row.institution_name,
    status: row.status,
    cursor: row.cursor,
    createdAt: row.created_at,
  };
}

function getItemRow(db: Database.Database, id: string): ItemRow {
  const row = db.prepare('SELECT * FROM plaid_items WHERE id = ?').get(id) as ItemRow | undefined;
  if (!row) throw new ImportError('plaid_item_not_found');
  return row;
}

export function getPlaidItem(db: Database.Database, id: string): PlaidItemRecord {
  return toRecord(getItemRow(db, id));
}

export function listPlaidItems(db: Database.Database): PlaidItemRecord[] {
  const rows = db.prepare('SELECT * FROM plaid_items ORDER BY created_at, rowid').all() as ItemRow[];
  return rows.map(toRecord);
}

export function listAccountLinks(db: Database.Database, itemId: string): PlaidAccountLink[] {
  const rows = db
    .prepare('SELECT * FROM plaid_account_links WHERE plaid_item_id = ? ORDER BY name, rowid')
    .all(itemId) as LinkRow[];
  return rows.map((r) => ({
    id: r.id,
    plaidAccountId: r.plaid_account_id,
    name: r.name,
    mask: r.mask,
    type: r.type,
    subtype: r.subtype,
    accountId: r.account_id,
    skipped: r.skipped === 1,
  }));
}

/** Decrypt the Item's access token — transient, server-side use ONLY (NFR-3). */
export function getAccessToken(db: Database.Database, masterKey: Buffer, itemId: string): string {
  return decryptField(masterKey, getItemRow(db, itemId).access_token_ciphertext);
}

export interface CreateLinkedItemInput {
  plaidItemId: string;
  accessToken: string;
  institutionName: string | null;
  accounts: PlaidDiscoveredAccount[];
}

/**
 * Persist a completed public-token exchange (S1 AC-1/AC-2): the Item lands in
 * `LINKING` with its token encrypted at rest and every discovered bank
 * account recorded unmapped, awaiting the user's mapping decision (AC-3).
 * Re-linking the same Plaid item replaces the previous record's token but
 * keeps its identity, cursor and mappings (the S4 update-mode contract).
 */
export function createLinkedItem(
  db: Database.Database,
  masterKey: Buffer,
  input: CreateLinkedItemInput,
): PlaidItemRecord {
  const envelope = encryptField(masterKey, input.accessToken);
  const run = db.transaction((): string => {
    const existing = db
      .prepare('SELECT id FROM plaid_items WHERE plaid_item_id = ?')
      .get(input.plaidItemId) as { id: string } | undefined;
    if (existing) {
      // Same Item linked again (Link update mode / a re-run of the flow):
      // refresh the token, keep cursor + mappings (architecture §6). A
      // NEEDS_RELINK Item returns to ACTIVE — the fresh token IS the repair
      // (S4 AC-2); LINKING stays LINKING (mapping still pending). UNLINKED
      // rows never collide here: unlink frees the plaid_item_id slot, so the
      // same bank re-links as a NEW Item (S5 AC-4 — no resurrection).
      db.prepare(
        `UPDATE plaid_items SET access_token_ciphertext = ?, institution_name = ?,
           status = CASE WHEN status = 'NEEDS_RELINK' THEN 'ACTIVE' ELSE status END,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
      ).run(envelope, input.institutionName, existing.id);
      return existing.id;
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO plaid_items (id, plaid_item_id, institution_name, access_token_ciphertext)
       VALUES (?, ?, ?, ?)`,
    ).run(id, input.plaidItemId, input.institutionName, envelope);
    const insertLink = db.prepare(
      `INSERT INTO plaid_account_links
         (id, plaid_item_id, plaid_account_id, name, mask, type, subtype)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const account of input.accounts) {
      insertLink.run(
        randomUUID(),
        id,
        account.plaidAccountId,
        account.name,
        account.mask,
        account.type,
        account.subtype,
      );
    }
    return id;
  });
  return getPlaidItem(db, run());
}

export interface AccountMappingInput {
  plaidAccountId: string;
  /** Map to this existing app account, or null. */
  accountId: string | null;
  /** Explicitly skip this bank account (S1 AC-3). */
  skipped: boolean;
}

/**
 * Record the user's mapping decisions and move the Item LINKING → ACTIVE
 * (S1 AC-2/AC-3). Unknown plaid account ids and unknown app accounts are
 * rejected whole — mappings apply atomically or not at all.
 */
export function applyAccountMappings(
  db: Database.Database,
  itemId: string,
  mappings: AccountMappingInput[],
): PlaidAccountLink[] {
  const run = db.transaction(() => {
    getItemRow(db, itemId); // 404s unknown items
    const update = db.prepare(
      `UPDATE plaid_account_links SET account_id = ?, skipped = ?
       WHERE plaid_item_id = ? AND plaid_account_id = ?`,
    );
    for (const mapping of mappings) {
      if (mapping.accountId !== null) getAccountRow(db, mapping.accountId); // 404s unknown accounts
      const accountId = mapping.skipped ? null : mapping.accountId;
      const result = update.run(accountId, mapping.skipped ? 1 : 0, itemId, mapping.plaidAccountId);
      if (result.changes === 0) throw new ImportError('plaid_account_link_not_found');
    }
    db.prepare(
      `UPDATE plaid_items SET status = 'ACTIVE',
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'LINKING'`,
    ).run(itemId);
  });
  run();
  return listAccountLinks(db, itemId);
}

/**
 * ACTIVE → NEEDS_RELINK (E5.S4 AC-1, FR-26): called when a sync attempt fails
 * with ITEM_LOGIN_REQUIRED. Guarded on ACTIVE so a stale failure can never
 * drag an already-UNLINKED (or still-LINKING) Item sideways.
 */
export function markNeedsRelink(db: Database.Database, itemId: string): void {
  db.prepare(
    `UPDATE plaid_items SET status = 'NEEDS_RELINK',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND status = 'ACTIVE'`,
  ).run(itemId);
}

/**
 * NEEDS_RELINK → ACTIVE after the user completes Link update mode (S4 AC-2).
 * Update mode re-authenticates the SAME Item — the stored access token grant
 * stays valid, so nothing is exchanged or re-encrypted; cursor and mappings
 * are untouched and the next sync resumes where it left off. Idempotent for
 * an already-ACTIVE Item; any other state is a 409.
 */
export function completeRelink(db: Database.Database, itemId: string): PlaidItemRecord {
  const row = getItemRow(db, itemId);
  if (row.status === 'NEEDS_RELINK') {
    db.prepare(
      `UPDATE plaid_items SET status = 'ACTIVE',
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    ).run(itemId);
  } else if (row.status !== 'ACTIVE') {
    throw new ImportError('plaid_item_not_active');
  }
  return getPlaidItem(db, itemId);
}

/**
 * Unlink (E5.S5, FR-28): revoke the access token at Plaid, discard the
 * ciphertext locally, and park the Item in the terminal UNLINKED state.
 *
 *  - The local discard ALWAYS proceeds: a failed/impossible revoke (dead
 *    token on a NEEDS_RELINK Item, Plaid unconfigured, no master key) is
 *    logged to sync health and swallowed (AC-3).
 *  - Imported transactions are untouched — nothing here goes near the ledger
 *    (AC-2). The row, its mappings and its sync log remain for audit (AC-4).
 *  - The plaid_item_id UNIQUE slot is freed (suffixed tombstone) so the same
 *    bank can be re-linked later as a brand-new Item even when the revoke
 *    failed and Plaid still knows the old item id (AC-4, no resurrection).
 */
export async function unlinkPlaidItem(
  db: Database.Database,
  masterKey: Buffer | null,
  client: PlaidClientPort | null,
  itemId: string,
): Promise<PlaidItemRecord> {
  const row = getItemRow(db, itemId);
  if (row.status === 'UNLINKED') return toRecord(row); // terminal — replay is a no-op

  try {
    if (masterKey === null) throw new Error('no master key — token cannot be decrypted');
    if (client === null) throw new Error('Plaid is not configured');
    await client.removeItem(decryptField(masterKey, row.access_token_ciphertext));
  } catch (err) {
    // AC-3: local discard proceeds anyway; the failure lands in sync health.
    appendSyncLog(db, itemId, {
      outcome: 'error',
      errorCode: err instanceof PlaidApiError ? err.plaidCode : null,
      message: `unlink: Plaid revoke failed (${err instanceof Error ? err.message : String(err)}); access token discarded locally`,
    });
  }

  db.prepare(
    `UPDATE plaid_items SET status = 'UNLINKED', access_token_ciphertext = '',
       plaid_item_id = plaid_item_id || ':unlinked:' || id,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`,
  ).run(itemId);
  return getPlaidItem(db, itemId);
}

/** Append one attempt to the Item's sync-health log (FR-27, S2 AC-7). */
export function appendSyncLog(
  db: Database.Database,
  itemId: string,
  entry: {
    outcome: 'success' | 'error';
    addedCount?: number;
    updatedCount?: number;
    removedCount?: number;
    errorCode?: string | null;
    message?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO plaid_sync_log
       (id, plaid_item_id, outcome, added_count, updated_count, removed_count, error_code, message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    itemId,
    entry.outcome,
    entry.addedCount ?? 0,
    entry.updatedCount ?? 0,
    entry.removedCount ?? 0,
    entry.errorCode ?? null,
    entry.message ?? null,
  );
}

/** Timestamp of the most recent SUCCESSFUL sync, for the connections view (FR-27). */
export function lastSuccessfulSyncAt(db: Database.Database, itemId: string): string | null {
  const row = db
    .prepare(
      `SELECT at FROM plaid_sync_log WHERE plaid_item_id = ? AND outcome = 'success'
       ORDER BY at DESC, rowid DESC LIMIT 1`,
    )
    .get(itemId) as { at: string } | undefined;
  return row?.at ?? null;
}

/** Newest-first sync attempts for the connection detail view (FR-27). */
export function listSyncLog(db: Database.Database, itemId: string, limit = 20): PlaidSyncLogEntry[] {
  const rows = db
    .prepare(
      `SELECT at, outcome, added_count, updated_count, removed_count, error_code, message
       FROM plaid_sync_log WHERE plaid_item_id = ?
       ORDER BY at DESC, rowid DESC LIMIT ?`,
    )
    .all(itemId, limit) as {
    at: string;
    outcome: 'success' | 'error';
    added_count: number;
    updated_count: number;
    removed_count: number;
    error_code: string | null;
    message: string | null;
  }[];
  return rows.map((r) => ({
    at: r.at,
    outcome: r.outcome,
    addedCount: r.added_count,
    updatedCount: r.updated_count,
    removedCount: r.removed_count,
    errorCode: r.error_code,
    message: r.message,
  }));
}
