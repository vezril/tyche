import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '@tyche/shared';
import type {
  AccountResponse,
  PlaidItemResponse,
  PlaidItemsResponse,
  PlaidLinkTokenResponse,
  PlaidSyncRunResponse,
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
 * E5 over HTTP (S1 link + mapping, S2 manual sync) with a fake PlaidApi
 * injected at the client-factory seam — the suite never calls Plaid. Includes
 * the NFR-3 mirror for ACCESS TOKENS: after linking, neither the raw SQLite
 * bytes nor any captured log line contains the plaintext token (ADR-007).
 */

const MASTER_KEY_HEX = 'c'.repeat(64);
const masterKey = loadMasterKey({ MASTER_KEY: MASTER_KEY_HEX });
const ACCESS_TOKEN = 'access-sandbox-deadbeef-1234-5678-9abc-def012345678';
const PUBLIC_TOKEN = 'public-sandbox-aaaa1111-bbbb-2222-cccc-3333dddd4444';

interface ScriptStep {
  page?: PlaidSyncPage;
  error?: Error;
}

class FakePlaidClient implements PlaidClientPort {
  credentials: { clientId: string; secret: string; environment: string } | null = null;
  exchangedPublicTokens: string[] = [];
  syncTokens: string[] = [];
  cursors: (string | null)[] = [];
  /** Access tokens passed to update-mode link-token creation (E5.S4). */
  updateModeTokens: string[] = [];
  /** Access tokens revoked via /item/remove (E5.S5). */
  removedTokens: string[] = [];
  private script: ScriptStep[] = [];

  queue(...steps: ScriptStep[]): void {
    this.script.push(...steps);
  }
  async createLinkToken(): Promise<string> {
    return 'link-sandbox-token-abc123';
  }
  async createUpdateLinkToken(accessToken: string): Promise<string> {
    this.updateModeTokens.push(accessToken);
    return 'link-sandbox-update-token-xyz789';
  }
  async removeItem(accessToken: string): Promise<void> {
    this.removedTokens.push(accessToken);
  }
  async exchangePublicToken(publicToken: string) {
    this.exchangedPublicTokens.push(publicToken);
    return { accessToken: ACCESS_TOKEN, plaidItemId: 'item-rbc-1' };
  }
  async getItemAccounts() {
    return {
      institutionName: 'RBC Royal Bank',
      accounts: [
        { plaidAccountId: 'pa-chq', name: 'RBC Chequing', mask: '1234', type: 'depository', subtype: 'checking' },
        { plaidAccountId: 'pa-sav', name: 'RBC Savings', mask: '5678', type: 'depository', subtype: 'savings' },
      ],
    };
  }
  async transactionsSync(accessToken: string, cursor: string | null): Promise<PlaidSyncPage> {
    this.syncTokens.push(accessToken);
    this.cursors.push(cursor);
    const step = this.script.shift();
    if (!step) throw new Error('fake Plaid client: script exhausted');
    if (step.error) throw step.error;
    return step.page!;
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

describe('Plaid link + sync API (E5.S1/S2)', () => {
  let rig: TestRig;
  let fake: FakePlaidClient;
  let logLines: string[];
  let chequing: AccountResponse;

  beforeEach(async () => {
    fake = new FakePlaidClient();
    logLines = [];
    rig = await createTestRig({
      masterKey,
      plaidClientFactory: (credentials) => {
        fake.credentials = credentials;
        return fake;
      },
      logSink: {
        write: (line: string) => {
          logLines.push(line);
          return true;
        },
      },
    });
    const created = await rig.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'Chequing', type: 'chequing', startingBalance: '0.00' },
    });
    chequing = created.json() as AccountResponse;
  });
  afterEach(() => rig.cleanup());

  async function configureCredentials(): Promise<void> {
    const res = await rig.inject({
      method: 'PUT',
      url: '/api/settings/plaid',
      payload: { clientId: 'client-abc', secret: 'plaid-secret-xyz' },
    });
    expect(res.statusCode).toBe(200);
  }

  async function linkItem(): Promise<PlaidItemResponse> {
    const res = await rig.inject({
      method: 'POST',
      url: '/api/plaid/items',
      payload: { publicToken: PUBLIC_TOKEN },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as PlaidItemResponse;
  }

  async function mapChequing(itemId: string): Promise<PlaidItemResponse> {
    const res = await rig.inject({
      method: 'PUT',
      url: `/api/plaid/items/${itemId}/mappings`,
      payload: {
        mappings: [
          { plaidAccountId: 'pa-chq', accountId: chequing.id, skipped: false },
          { plaidAccountId: 'pa-sav', accountId: null, skipped: true },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as PlaidItemResponse;
  }

  describe('S1 AC-1: link token', () => {
    it('creates a link token from the stored credentials and chosen environment', async () => {
      await configureCredentials();
      const res = await rig.inject({ method: 'POST', url: '/api/plaid/link-token' });
      expect(res.statusCode).toBe(200);
      expect(res.json() as PlaidLinkTokenResponse).toEqual({ linkToken: 'link-sandbox-token-abc123' });
      expect(fake.credentials).toEqual({
        clientId: 'client-abc',
        secret: 'plaid-secret-xyz',
        environment: 'sandbox', // the default until the setting flips it
      });
    });

    it('refuses with plaid_not_configured before credentials exist', async () => {
      const res = await rig.inject({ method: 'POST', url: '/api/plaid/link-token' });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('plaid_not_configured');
    });

    it('honours the plaid_env setting when creating the client', async () => {
      await configureCredentials();
      await rig.inject({
        method: 'PUT',
        url: '/api/settings/plaid_env',
        payload: { value: 'production' },
      });
      await rig.inject({ method: 'POST', url: '/api/plaid/link-token' });
      expect(fake.credentials?.environment).toBe('production');
    });
  });

  describe('S1 AC-2/AC-3/AC-5: exchange, mapping, connections view', () => {
    beforeEach(configureCredentials);

    it('exchanges the public token, lands the Item in LINKING with its discovered accounts unmapped', async () => {
      const item = await linkItem();
      expect(fake.exchangedPublicTokens).toEqual([PUBLIC_TOKEN]);
      expect(item).toMatchObject({ institutionName: 'RBC Royal Bank', status: 'LINKING' });
      expect(item.accounts).toHaveLength(2);
      expect(item.accounts[0]).toMatchObject({
        plaidAccountId: 'pa-chq',
        name: 'RBC Chequing',
        mask: '1234',
        accountId: null,
        skipped: false,
      });
      // and the response NEVER carries the access token in any field
      expect(JSON.stringify(item)).not.toContain(ACCESS_TOKEN);
    });

    it('NFR-3 (ADR-007): the raw SQLite bytes and the captured logs contain no plaintext access token', async () => {
      await linkItem();
      for (const suffix of ['', '-wal', '-shm']) {
        const file = join(rig.dir, `app.db${suffix}`);
        if (!existsSync(file)) continue;
        const bytes = readFileSync(file).toString('latin1');
        expect(bytes, `plaintext access token found in app.db${suffix}`).not.toContain(ACCESS_TOKEN);
        expect(bytes, `master key found in app.db${suffix}`).not.toContain(MASTER_KEY_HEX);
      }
      const logs = logLines.join('');
      expect(logs.length).toBeGreaterThan(0);
      expect(logs).not.toContain(ACCESS_TOKEN);
      // belt and braces: the redaction layer censors accessToken fields outright
      rig.app.log.info({ accessToken: ACCESS_TOKEN, body: { access_token: ACCESS_TOKEN } }, 'x');
      expect(logLines.join('')).not.toContain(ACCESS_TOKEN);
    });

    it('AC-3: each discovered account is individually mappable or skippable; the Item moves to ACTIVE', async () => {
      const item = await linkItem();
      const mapped = await mapChequing(item.id);
      expect(mapped.status).toBe('ACTIVE');
      expect(mapped.accounts.find((a) => a.plaidAccountId === 'pa-chq')).toMatchObject({
        accountId: chequing.id,
        accountName: 'Chequing',
        skipped: false,
      });
      expect(mapped.accounts.find((a) => a.plaidAccountId === 'pa-sav')).toMatchObject({
        accountId: null,
        skipped: true,
      });
    });

    it('AC-5: GET /api/plaid/items lists institution, mapped accounts, and state', async () => {
      const item = await linkItem();
      await mapChequing(item.id);
      const res = await rig.inject({ method: 'GET', url: '/api/plaid/items' });
      const body = res.json() as PlaidItemsResponse;
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({
        institutionName: 'RBC Royal Bank',
        status: 'ACTIVE',
        lastAttempt: null,
        lastSuccessAt: null,
      });
    });

    it('mapping an unknown plaid account 404s', async () => {
      const item = await linkItem();
      const res = await rig.inject({
        method: 'PUT',
        url: `/api/plaid/items/${item.id}/mappings`,
        payload: { mappings: [{ plaidAccountId: 'pa-nope', accountId: null, skipped: true }] },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('S2: manual "sync now"', () => {
    let itemId: string;

    beforeEach(async () => {
      await configureCredentials();
      const item = await linkItem();
      await mapChequing(item.id);
      itemId = item.id;
    });

    it('AC-1/AC-7: applies added transactions, returns counts + balances, and the health log records the attempt', async () => {
      fake.queue({
        page: page({ added: [txn('p-1'), txn('p-2', { amount: '-1000.00', name: 'PAY' })], nextCursor: 'c1' }),
      });
      const res = await rig.inject({ method: 'POST', url: `/api/plaid/items/${itemId}/sync` });
      expect(res.statusCode).toBe(200);
      const body = res.json() as PlaidSyncRunResponse;
      expect(body).toMatchObject({ itemId, addedCount: 2, updatedCount: 0, ignoredUnmappedCount: 0 });
      expect(body.accountBalances).toEqual([
        {
          accountId: chequing.id,
          workingBalanceMilliunits: 994750, // -5.25 + 1000.00
          clearedBalanceMilliunits: 994750,
        },
      ]);
      expect(fake.syncTokens[0]).toBe(ACCESS_TOKEN); // decrypted transiently, server-side only

      const reg = await rig.inject({
        method: 'GET',
        url: `/api/accounts/${chequing.id}/transactions?limit=100`,
      });
      const rows = (reg.json() as RegisterResponse).transactions.filter((t) => !t.isStartingBalance);
      expect(rows).toHaveLength(2);
      expect(rows.every((t) => t.source === 'plaid' && !t.approved && t.status === 'cleared')).toBe(true);

      const items = (await rig.inject({ method: 'GET', url: '/api/plaid/items' })).json() as PlaidItemsResponse;
      expect(items.items[0]!.lastAttempt).toMatchObject({ outcome: 'success', addedCount: 2 });
      expect(items.items[0]!.lastSuccessAt).not.toBeNull();
    });

    it('an upstream Plaid failure maps to 502 with the Plaid code, and the log records the error (AC-7)', async () => {
      fake.queue({ error: new PlaidApiError('ITEM_LOGIN_REQUIRED', 'relink please') });
      const res = await rig.inject({ method: 'POST', url: `/api/plaid/items/${itemId}/sync` });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ error: 'plaid_api_error', plaidCode: 'ITEM_LOGIN_REQUIRED' });
      const items = (await rig.inject({ method: 'GET', url: '/api/plaid/items' })).json() as PlaidItemsResponse;
      expect(items.items[0]!.lastAttempt).toMatchObject({
        outcome: 'error',
        errorCode: 'ITEM_LOGIN_REQUIRED',
      });
    });

    it('syncing an unknown item 404s; syncing a still-LINKING item 409s', async () => {
      expect((await rig.inject({ method: 'POST', url: '/api/plaid/items/nope/sync' })).statusCode).toBe(404);
      rig.db.prepare("UPDATE plaid_items SET status = 'LINKING' WHERE id = ?").run(itemId);
      expect((await rig.inject({ method: 'POST', url: `/api/plaid/items/${itemId}/sync` })).statusCode).toBe(409);
    });
  });

  describe('the wall', () => {
    it('every /api/plaid route requires a session, and mutations require the CSRF header', async () => {
      await configureCredentials();
      // no session cookie
      const unauthed = await rig.app.inject({
        method: 'POST',
        url: '/api/plaid/link-token',
        headers: { [CSRF_HEADER]: '1' },
      });
      expect(unauthed.statusCode).toBe(401);
      expect((await rig.app.inject({ method: 'GET', url: '/api/plaid/items' })).statusCode).toBe(401);
      // session but no CSRF header
      const noCsrf = await rig.app.inject({
        method: 'POST',
        url: '/api/plaid/link-token',
        headers: { cookie: rig.authed.cookie },
      });
      expect(noCsrf.statusCode).toBe(403);
    });

    it('secret-bearing routes answer 503 when the app runs without a master key', async () => {
      const bare = await createTestRig(); // no masterKey
      try {
        const res = await bare.inject({ method: 'POST', url: '/api/plaid/link-token' });
        expect(res.statusCode).toBe(503);
      } finally {
        await bare.cleanup();
      }
    });
  });
});
