import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AccountResponse,
  PlaidItemResponse,
  PlaidItemsResponse,
  PlaidLinkTokenResponse,
  RegisterResponse,
} from '@tyche/shared';
import { loadMasterKey } from '../../src/crypto/index.js';
import {
  PlaidApiError,
  type PlaidClientPort,
  type PlaidSyncPage,
  type PlaidTransactionData,
} from '../../src/importing/index.js';
import { createTestRig, type TestRig } from './helpers.js';

/**
 * E5.S4 (broken connection, re-link, sync health — FR-26/27) and E5.S5
 * (unlink — FR-28) over HTTP, with the fake PlaidClientPort injected at the
 * client-factory seam — ITEM_LOGIN_REQUIRED is "simulated in sandbox" by
 * scripting the fake, exactly the failure shape the real adapter surfaces.
 */

const MASTER_KEY_HEX = 'e'.repeat(64);
const masterKey = loadMasterKey({ MASTER_KEY: MASTER_KEY_HEX });
const ACCESS_TOKEN = 'access-sandbox-feedface-1111-2222-3333-444455556666';

interface ScriptStep {
  page?: PlaidSyncPage;
  error?: Error;
}

class FakePlaidClient implements PlaidClientPort {
  cursors: (string | null)[] = [];
  /** Access tokens handed to update-mode link-token creation (S4). */
  updateModeTokens: string[] = [];
  /** Access tokens revoked via /item/remove (S5). */
  removedTokens: string[] = [];
  /** When set, /item/remove fails with this (S5 AC-3). */
  removeItemError: Error | null = null;
  private script: ScriptStep[] = [];

  queue(...steps: ScriptStep[]): void {
    this.script.push(...steps);
  }
  async createLinkToken(): Promise<string> {
    return 'link-sandbox-token';
  }
  async createUpdateLinkToken(accessToken: string): Promise<string> {
    this.updateModeTokens.push(accessToken);
    return 'link-sandbox-update-token';
  }
  async exchangePublicToken(): Promise<{ accessToken: string; plaidItemId: string }> {
    return { accessToken: ACCESS_TOKEN, plaidItemId: 'item-rbc-1' };
  }
  async getItemAccounts(): Promise<{
    institutionName: string;
    accounts: { plaidAccountId: string; name: string; mask: null; type: string; subtype: null }[];
  }> {
    return {
      institutionName: 'RBC Royal Bank',
      accounts: [{ plaidAccountId: 'pa-chq', name: 'RBC Chequing', mask: null, type: 'depository', subtype: null }],
    };
  }
  async transactionsSync(_accessToken: string, cursor: string | null): Promise<PlaidSyncPage> {
    this.cursors.push(cursor);
    const step = this.script.shift();
    if (!step) throw new Error('fake Plaid client: script exhausted');
    if (step.error) throw step.error;
    return step.page!;
  }
  async removeItem(accessToken: string): Promise<void> {
    if (this.removeItemError) throw this.removeItemError;
    this.removedTokens.push(accessToken);
  }
}

function txn(transactionId: string, over: Partial<PlaidTransactionData> = {}): PlaidTransactionData {
  return {
    transactionId,
    plaidAccountId: 'pa-chq',
    date: '2026-06-05',
    name: 'TIM HORTONS #2241',
    amount: '5.25',
    pending: false,
    raw: { transaction_id: transactionId },
    ...over,
  };
}

function page(over: Partial<PlaidSyncPage> = {}): PlaidSyncPage {
  return { added: [], modified: [], removed: [], nextCursor: 'c1', hasMore: false, ...over };
}

const LOGIN_REQUIRED = (): ScriptStep => ({
  error: new PlaidApiError('ITEM_LOGIN_REQUIRED', 'the login details of this item have changed'),
});

describe('Plaid re-link + sync health (E5.S4) and unlink (E5.S5)', () => {
  let rig: TestRig;
  let fake: FakePlaidClient;
  let chequing: AccountResponse;
  let itemId: string;

  beforeEach(async () => {
    fake = new FakePlaidClient();
    rig = await createTestRig({ masterKey, plaidClientFactory: () => fake });
    chequing = (
      await rig.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'Chequing', type: 'chequing', startingBalance: '0.00' },
      })
    ).json() as AccountResponse;
    await rig.inject({
      method: 'PUT',
      url: '/api/settings/plaid',
      payload: { clientId: 'client-abc', secret: 'plaid-secret-xyz' },
    });
    const item = (
      await rig.inject({ method: 'POST', url: '/api/plaid/items', payload: { publicToken: 'pt-1' } })
    ).json() as PlaidItemResponse;
    itemId = item.id;
    await rig.inject({
      method: 'PUT',
      url: `/api/plaid/items/${itemId}/mappings`,
      payload: { mappings: [{ plaidAccountId: 'pa-chq', accountId: chequing.id, skipped: false }] },
    });
  });
  afterEach(() => rig.cleanup());

  async function syncNow(): Promise<number> {
    const res = await rig.inject({ method: 'POST', url: `/api/plaid/items/${itemId}/sync` });
    return res.statusCode;
  }

  async function getItem(): Promise<PlaidItemResponse> {
    const body = (await rig.inject({ method: 'GET', url: '/api/plaid/items' })).json() as PlaidItemsResponse;
    return body.items.find((i) => i.id === itemId)!;
  }

  async function registerRows(): Promise<RegisterResponse['transactions']> {
    const res = await rig.inject({
      method: 'GET',
      url: `/api/accounts/${chequing.id}/transactions?limit=100`,
    });
    return (res.json() as RegisterResponse).transactions.filter((t) => !t.isStartingBalance);
  }

  describe('S4 AC-1: ITEM_LOGIN_REQUIRED marks the connection broken and pauses it', () => {
    it('flips the Item to NEEDS_RELINK and the items payload carries the banner data (last success)', async () => {
      fake.queue({ page: page({ added: [txn('p-1')] }) }); // a healthy sync first
      expect(await syncNow()).toBe(200);
      fake.queue(LOGIN_REQUIRED());
      expect(await syncNow()).toBe(502);

      const item = await getItem();
      expect(item.status).toBe('NEEDS_RELINK');
      expect(item.lastSuccessAt).not.toBeNull(); // the banner's "last successful sync" time
      expect(item.lastAttempt).toMatchObject({ outcome: 'error', errorCode: 'ITEM_LOGIN_REQUIRED' });
    });

    it('further syncs of the broken Item are refused (paused) until re-link', async () => {
      fake.queue(LOGIN_REQUIRED());
      await syncNow();
      expect(await syncNow()).toBe(409); // no script left — never reaches Plaid
    });
  });

  describe('S4 AC-3/AC-4: per-connection sync health (FR-27)', () => {
    it('shows last attempt, last success, and the outcome of recent attempts after a failed poll', async () => {
      fake.queue({ page: page({ added: [txn('p-1')] }) });
      await syncNow();
      fake.queue({ error: new PlaidApiError('INSTITUTION_DOWN', 'RBC is unavailable') });
      expect(await syncNow()).toBe(502);

      const item = await getItem();
      expect(item.lastAttempt).toMatchObject({ outcome: 'error', errorCode: 'INSTITUTION_DOWN' });
      expect(item.lastAttempt!.at).toBeTruthy(); // the failure timestamp is visible
      expect(item.lastSuccessAt).not.toBeNull();
      expect(item.syncLog.map((e) => e.outcome)).toEqual(['error', 'success']);
      // AC-4: a non-auth failure is logged WITHOUT flipping the state machine
      expect(item.status).toBe('ACTIVE');
    });
  });

  describe('S4 AC-2: re-link via Link update mode', () => {
    beforeEach(async () => {
      fake.queue({ page: page({ added: [txn('p-1')], nextCursor: 'c1' }) });
      await syncNow(); // cursor now 'c1'
      fake.queue(LOGIN_REQUIRED());
      await syncNow(); // → NEEDS_RELINK
    });

    it('creates the update-mode link token against the Item’s own access token', async () => {
      const res = await rig.inject({ method: 'POST', url: `/api/plaid/items/${itemId}/relink-token` });
      expect(res.statusCode).toBe(200);
      expect(res.json() as PlaidLinkTokenResponse).toEqual({ linkToken: 'link-sandbox-update-token' });
      expect(fake.updateModeTokens).toEqual([ACCESS_TOKEN]); // SAME Item, not a new link
    });

    it('completing update mode returns the Item to ACTIVE; cursor and mappings survive; no duplicates', async () => {
      const res = await rig.inject({ method: 'POST', url: `/api/plaid/items/${itemId}/relinked` });
      expect(res.statusCode).toBe(200);
      const relinked = res.json() as PlaidItemResponse;
      expect(relinked.status).toBe('ACTIVE'); // banner data clears
      // mappings preserved — no re-mapping step (AC-2)
      expect(relinked.accounts[0]).toMatchObject({ plaidAccountId: 'pa-chq', accountId: chequing.id });

      // next sync resumes from the preserved cursor; a redelivered row dedups
      fake.queue({ page: page({ added: [txn('p-1'), txn('p-2')], nextCursor: 'c2' }) });
      expect(await syncNow()).toBe(200);
      expect(fake.cursors.at(-1)).toBe('c1'); // resumed, not restarted
      expect((await registerRows()).map((t) => t.payee).sort()).toHaveLength(2); // p-1 deduped, p-2 added
    });

    it('a full re-link (public-token exchange for the same Plaid item) also restores ACTIVE in place', async () => {
      const res = await rig.inject({
        method: 'POST',
        url: '/api/plaid/items',
        payload: { publicToken: 'pt-again' },
      });
      expect(res.statusCode).toBe(201);
      const item = res.json() as PlaidItemResponse;
      expect(item.id).toBe(itemId); // same Item, upserted — not a duplicate
      expect(item.status).toBe('ACTIVE');
      expect(item.accounts[0]).toMatchObject({ accountId: chequing.id }); // mappings kept

      const list = (await rig.inject({ method: 'GET', url: '/api/plaid/items' })).json() as PlaidItemsResponse;
      expect(list.items).toHaveLength(1);
    });

    it('refuses a relink-token for an UNLINKED Item and "relinked" for a LINKING one', async () => {
      rig.db.prepare("UPDATE plaid_items SET status = 'UNLINKED' WHERE id = ?").run(itemId);
      expect(
        (await rig.inject({ method: 'POST', url: `/api/plaid/items/${itemId}/relink-token` })).statusCode,
      ).toBe(409);
      rig.db.prepare("UPDATE plaid_items SET status = 'LINKING' WHERE id = ?").run(itemId);
      expect(
        (await rig.inject({ method: 'POST', url: `/api/plaid/items/${itemId}/relinked` })).statusCode,
      ).toBe(409);
    });
  });

  describe('S5: unlink', () => {
    beforeEach(async () => {
      fake.queue({ page: page({ added: [txn('p-1'), txn('p-2', { amount: '-1000.00', name: 'PAY' })] }) });
      await syncNow(); // imported history that MUST survive the unlink
    });

    async function unlink(): Promise<PlaidItemResponse> {
      const res = await rig.inject({ method: 'POST', url: `/api/plaid/items/${itemId}/unlink` });
      expect(res.statusCode).toBe(200);
      return res.json() as PlaidItemResponse;
    }

    it('AC-1: revokes the token at Plaid, discards it locally, and stops all syncing', async () => {
      const item = await unlink();
      expect(item.status).toBe('UNLINKED');
      expect(fake.removedTokens).toEqual([ACCESS_TOKEN]); // /item/remove was called
      // ciphertext discarded — nothing decryptable remains at rest
      const row = rig.db
        .prepare('SELECT access_token_ciphertext FROM plaid_items WHERE id = ?')
        .get(itemId) as { access_token_ciphertext: string };
      expect(row.access_token_ciphertext).toBe('');
      // no further sync attempts: the route refuses before touching Plaid
      expect(await syncNow()).toBe(409);
    });

    it('AC-2: every imported transaction and its balances are untouched', async () => {
      const before = await registerRows();
      await unlink();
      const after = await registerRows();
      expect(after).toEqual(before);
      expect(after).toHaveLength(2);
    });

    it('AC-3: when the Plaid revoke fails, the local discard still proceeds and the failure is in sync health', async () => {
      fake.removeItemError = new PlaidApiError('ITEM_LOGIN_REQUIRED', 'token already dead');
      const item = await unlink();
      expect(item.status).toBe('UNLINKED');
      expect(fake.removedTokens).toEqual([]);
      expect(item.lastAttempt).toMatchObject({ outcome: 'error', errorCode: 'ITEM_LOGIN_REQUIRED' });
      expect(item.lastAttempt!.message).toContain('unlink');
    });

    it('AC-4: the record stays visible as inactive, and the same bank re-links as a NEW Item', async () => {
      await unlink();
      const list = (await rig.inject({ method: 'GET', url: '/api/plaid/items' })).json() as PlaidItemsResponse;
      expect(list.items).toHaveLength(1);
      expect(list.items[0]).toMatchObject({ institutionName: 'RBC Royal Bank', status: 'UNLINKED' });
      expect(list.items[0]!.accounts).toHaveLength(1); // mappings kept for audit
      expect(list.items[0]!.syncLog.length).toBeGreaterThan(0); // history kept for audit

      // Plaid reports the same item id (revoke may even have failed upstream):
      // a fresh link must create a NEW Item, never resurrect the UNLINKED one.
      const relink = await rig.inject({
        method: 'POST',
        url: '/api/plaid/items',
        payload: { publicToken: 'pt-new' },
      });
      expect(relink.statusCode).toBe(201);
      const fresh = relink.json() as PlaidItemResponse;
      expect(fresh.id).not.toBe(itemId);
      expect(fresh.status).toBe('LINKING');
      const both = (await rig.inject({ method: 'GET', url: '/api/plaid/items' })).json() as PlaidItemsResponse;
      expect(both.items).toHaveLength(2);
    });

    it('unlinking twice is a no-op replay — the revoke is not re-attempted', async () => {
      await unlink();
      const again = await unlink();
      expect(again.status).toBe('UNLINKED');
      expect(fake.removedTokens).toHaveLength(1);
    });

    it('unlink proceeds locally even when Plaid is no longer configured, logging the skipped revoke', async () => {
      await rig.inject({ method: 'DELETE', url: '/api/settings/plaid' });
      const item = await unlink();
      expect(item.status).toBe('UNLINKED');
      expect(fake.removedTokens).toEqual([]);
      expect(item.lastAttempt).toMatchObject({ outcome: 'error' });
      expect(item.lastAttempt!.message).toContain('unlink');
    });
  });
});
