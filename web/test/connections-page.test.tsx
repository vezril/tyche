import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CSRF_HEADER, type AccountResponse, type PlaidItemResponse } from '@ynab-clone/shared';
import { ConnectionsPage } from '../src/pages/ConnectionsPage.js';
import type { PlaidLinkCreateOptions, PlaidLinkGlobal } from '../src/pages/plaid-link.js';

/**
 * Component tests for the connections screen (E5.S1/S2). The API is
 * integration-tested in server/test/web/plaid-api.test.ts; here `fetch` and
 * the Plaid Link loader are mocked to pin the UI contract: the link flow
 * (token → widget → public-token exchange), the per-account mapping table
 * with skip (S1 AC-3/AC-5), manual sync (S2), and — AC-4/NFR-2 — that the
 * CDN loader is touched only when a link flow starts, never on render.
 */

function account(over: Partial<AccountResponse>): AccountResponse {
  return {
    id: 'a1',
    name: 'Chequing',
    type: 'chequing',
    onBudget: true,
    closed: false,
    workingBalanceMilliunits: 0,
    clearedBalanceMilliunits: 0,
    ...over,
  };
}

const ACCOUNTS = [account({}), account({ id: 'a2', name: 'Savings', type: 'savings' })];

function item(over: Partial<PlaidItemResponse> = {}): PlaidItemResponse {
  return {
    id: 'item-1',
    institutionName: 'RBC Royal Bank',
    status: 'ACTIVE',
    accounts: [
      {
        plaidAccountId: 'pa-chq',
        name: 'RBC Chequing',
        mask: '1234',
        type: 'depository',
        subtype: 'checking',
        accountId: 'a1',
        accountName: 'Chequing',
        skipped: false,
      },
      {
        plaidAccountId: 'pa-sav',
        name: 'RBC Savings',
        mask: '5678',
        type: 'depository',
        subtype: 'savings',
        accountId: null,
        accountName: null,
        skipped: false,
      },
    ],
    lastAttempt: { at: '2026-06-11T06:00:00Z', outcome: 'success', addedCount: 2, updatedCount: 0, removedCount: 0, errorCode: null, message: null },
    lastSuccessAt: '2026-06-11T06:00:00Z',
    syncLog: [],
    ...over,
  };
}

let items: PlaidItemResponse[];
let configured: boolean;
let sends: { method: string; url: string; headers: Record<string, string>; body: unknown }[];
let syncResponse: unknown;

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}

/** Fake Plaid Link global: capture create() options, auto-drive on open(). */
let linkLoader: ReturnType<typeof vi.fn<() => Promise<PlaidLinkGlobal>>>;
let lastCreate: PlaidLinkCreateOptions | null;

beforeEach(() => {
  items = [item()];
  configured = true;
  sends = [];
  lastCreate = null;
  syncResponse = {
    itemId: 'item-1',
    addedCount: 3,
    mergedCount: 1,
    updatedCount: 1,
    removedVoidedCount: 0,
    removedFlaggedCount: 1,
    duplicateCount: 0,
    ignoredUnmappedCount: 0,
    errors: [],
    accountBalances: [{ accountId: 'a1', workingBalanceMilliunits: 100, clearedBalanceMilliunits: 100 }],
  };
  linkLoader = vi.fn(async (): Promise<PlaidLinkGlobal> => ({
    create: (options: PlaidLinkCreateOptions) => {
      lastCreate = options;
      return {
        open: () => options.onSuccess('public-sandbox-token-42'),
        exit: () => undefined,
      };
    },
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url === '/api/settings') {
        return jsonResponse({
          plaid: { configured, clientId: configured ? 'client-abc' : null },
          pollingIntervalHours: 6,
          sessionIdleExpiryDays: 30,
        });
      }
      if (method === 'GET' && url === '/api/plaid/items') {
        return jsonResponse({ items });
      }
      sends.push({
        method,
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body === undefined || init.body === null ? null : JSON.parse(String(init.body)),
      });
      if (url === '/api/plaid/link-token') return jsonResponse({ linkToken: 'link-token-1' });
      if (url === '/api/plaid/items' && method === 'POST') {
        items = [item({ status: 'LINKING', lastAttempt: null, lastSuccessAt: null })];
        return jsonResponse(items[0]);
      }
      if (url.endsWith('/mappings')) return jsonResponse(items[0]);
      if (url.endsWith('/sync')) return jsonResponse(syncResponse);
      if (url.endsWith('/relink-token')) return jsonResponse({ linkToken: 'update-link-token-1' });
      if (url.endsWith('/relinked')) {
        items = [item()]; // back to ACTIVE, cursor + mappings untouched (S4 AC-2)
        return jsonResponse(items[0]);
      }
      if (url.endsWith('/unlink')) {
        items = [item({ status: 'UNLINKED' })];
        return jsonResponse(items[0]);
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderPage(extra: {
  onItems?: ReturnType<typeof vi.fn>;
  relinkItemId?: string | null;
  onRelinkHandled?: ReturnType<typeof vi.fn>;
} = {}): Promise<{ onBalances: ReturnType<typeof vi.fn>; onChanged: ReturnType<typeof vi.fn> }> {
  const onBalances = vi.fn();
  const onChanged = vi.fn();
  render(
    <ConnectionsPage
      accounts={ACCOUNTS}
      onBalances={onBalances}
      onChanged={onChanged}
      linkLoader={linkLoader}
      {...extra}
    />,
  );
  await screen.findByText('RBC Royal Bank');
  return { onBalances, onChanged };
}

describe('ConnectionsPage (E5.S1/S2)', () => {
  it('S1 AC-5: lists each Item with institution, state, and per-account mappings', async () => {
    await renderPage();
    expect(screen.getByText('RBC Royal Bank')).toBeDefined();
    expect(screen.getByText('ACTIVE')).toBeDefined();
    expect(screen.getByText(/Last successful sync: 2026-06-11/)).toBeDefined();
    const chq = screen.getByLabelText('Map RBC Chequing') as HTMLSelectElement;
    expect(chq.value).toBe('a1'); // existing mapping pre-selected
    const sav = screen.getByLabelText('Map RBC Savings') as HTMLSelectElement;
    expect(sav.value).toBe(''); // unmapped, no decision yet
  });

  it('S1 AC-4 (NFR-2): rendering never touches the Plaid CDN loader — only starting a link flow does', async () => {
    await renderPage();
    expect(linkLoader).not.toHaveBeenCalled();
    expect(document.querySelector('script[src*="cdn.plaid.com"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add bank connection' }));
    await screen.findByText(/Map each discovered bank account/);
    expect(linkLoader).toHaveBeenCalledTimes(1);
  });

  it('S1 AC-1/AC-2: the link flow fetches a link token, opens Link with it, and exchanges the public token', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Add bank connection' }));
    await screen.findByText(/Map each discovered bank account/);
    expect(sends[0]).toMatchObject({ method: 'POST', url: '/api/plaid/link-token' });
    expect(sends[0]!.headers[CSRF_HEADER]).toBe('1');
    expect(lastCreate?.token).toBe('link-token-1');
    expect(sends[1]).toMatchObject({
      method: 'POST',
      url: '/api/plaid/items',
      body: { publicToken: 'public-sandbox-token-42' },
    });
    await screen.findByText('LINKING'); // the fresh Item appears, awaiting mapping
  });

  it('S1 AC-3: each bank account maps to an app account or is skipped, saved in one PUT', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText('Map RBC Chequing'), { target: { value: 'a2' } });
    fireEvent.change(screen.getByLabelText('Map RBC Savings'), { target: { value: '__skip__' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save mapping' }));
    await screen.findByText('Mapping saved.');
    expect(sends[0]).toMatchObject({
      method: 'PUT',
      url: '/api/plaid/items/item-1/mappings',
      body: {
        mappings: [
          { plaidAccountId: 'pa-chq', accountId: 'a2', skipped: false },
          { plaidAccountId: 'pa-sav', accountId: null, skipped: true },
        ],
      },
    });
  });

  it('S2: "Sync now" posts the sync, reports counts, and pushes balances + badge refresh to the shell', async () => {
    const { onBalances, onChanged } = await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    await screen.findByText(/Synced RBC Royal Bank: 3 new, 1 matched, 1 updated, 1 removed\./);
    expect(sends[0]).toMatchObject({ method: 'POST', url: '/api/plaid/items/item-1/sync' });
    expect(onBalances).toHaveBeenCalledWith([
      { accountId: 'a1', workingBalanceMilliunits: 100, clearedBalanceMilliunits: 100 },
    ]);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('a failed sync surfaces the upstream error and Sync now is disabled for non-ACTIVE items', async () => {
    items = [item({ status: 'LINKING' })];
    await renderPage();
    const sync = screen.getByRole('button', { name: 'Sync now' }) as HTMLButtonElement;
    expect(sync.disabled).toBe(true);
  });

  it('reports loaded Items up to the shell so the app-wide banner stays fresh (S4)', async () => {
    const onItems = vi.fn();
    await renderPage({ onItems });
    expect(onItems).toHaveBeenCalledWith(items);
  });

  describe('S4: re-link via Link update mode (FR-26)', () => {
    beforeEach(() => {
      items = [
        item({
          status: 'NEEDS_RELINK',
          lastAttempt: {
            at: '2026-06-12T06:00:00Z',
            outcome: 'error',
            addedCount: 0,
            updatedCount: 0,
            removedCount: 0,
            errorCode: 'ITEM_LOGIN_REQUIRED',
            message: null,
          },
        }),
      ];
    });

    it('AC-2: Re-link fetches an update-mode token, opens Link with it, confirms, and the state returns to ACTIVE', async () => {
      await renderPage();
      expect(screen.getByText('NEEDS_RELINK')).toBeDefined();
      fireEvent.click(screen.getByRole('button', { name: 'Re-link' }));
      await screen.findByText(/re-linked\. Sync resumes where it left off\./);
      expect(linkLoader).toHaveBeenCalledTimes(1);
      expect(lastCreate?.token).toBe('update-link-token-1'); // the UPDATE-mode token, not a fresh link
      expect(sends[0]).toMatchObject({ method: 'POST', url: '/api/plaid/items/item-1/relink-token' });
      // no public-token exchange — update mode repairs the SAME Item
      expect(sends[1]).toMatchObject({ method: 'POST', url: '/api/plaid/items/item-1/relinked', body: null });
      await screen.findByText('ACTIVE'); // banner-state cleared, no re-mapping step
    });

    it('AC-5: arriving from the shell banner starts update mode directly', async () => {
      const onRelinkHandled = vi.fn();
      await renderPage({ relinkItemId: 'item-1', onRelinkHandled });
      await screen.findByText(/re-linked\. Sync resumes where it left off\./);
      expect(onRelinkHandled).toHaveBeenCalledTimes(1);
      expect(sends[0]).toMatchObject({ method: 'POST', url: '/api/plaid/items/item-1/relink-token' });
    });
  });

  describe('S4 AC-3: per-connection sync-health detail (FR-27)', () => {
    it('shows last attempt, last success, and the outcome of recent attempts including failures', async () => {
      items = [
        item({
          lastAttempt: {
            at: '2026-06-12T06:00:00Z',
            outcome: 'error',
            addedCount: 0,
            updatedCount: 0,
            removedCount: 0,
            errorCode: 'INSTITUTION_DOWN',
            message: 'RBC is unavailable',
          },
          syncLog: [
            { at: '2026-06-12T06:00:00Z', outcome: 'error', addedCount: 0, updatedCount: 0, removedCount: 0, errorCode: 'INSTITUTION_DOWN', message: 'RBC is unavailable' },
            { at: '2026-06-11T06:00:00Z', outcome: 'success', addedCount: 2, updatedCount: 1, removedCount: 0, errorCode: null, message: null },
          ],
        }),
      ];
      await renderPage();
      expect(screen.getByText(/Last successful sync: 2026-06-11T06:00:00Z/)).toBeDefined();
      expect(screen.getByText(/Last attempt: 2026-06-12T06:00:00Z\./)).toBeDefined();
      expect(screen.getByText(/Last attempt failed \(INSTITUTION_DOWN\)\./)).toBeDefined();
      // the recent-attempts detail: a failed row with its code, a success row with counts
      expect(screen.getByText('Sync history')).toBeDefined();
      expect(screen.getByText('INSTITUTION_DOWN')).toBeDefined();
      expect(screen.getByText('2 added, 1 updated, 0 removed')).toBeDefined();
    });
  });

  describe('S5: unlink (FR-28)', () => {
    it('AC-1: asks for confirmation, posts the unlink, and renders the connection as UNLINKED', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const { onChanged } = await renderPage();
      fireEvent.click(screen.getByRole('button', { name: 'Unlink…' }));
      await screen.findByText(/RBC Royal Bank unlinked\. Imported transactions were kept\./);
      expect(confirmSpy).toHaveBeenCalledOnce();
      expect(confirmSpy.mock.calls[0]![0]).toContain('stays in your register'); // FR-28 promise in the prompt
      expect(sends[0]).toMatchObject({ method: 'POST', url: '/api/plaid/items/item-1/unlink' });
      expect(onChanged).toHaveBeenCalledTimes(1);
      await screen.findByText('UNLINKED');
    });

    it('declining the confirmation sends nothing', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      await renderPage();
      fireEvent.click(screen.getByRole('button', { name: 'Unlink…' }));
      expect(sends).toHaveLength(0);
    });

    it('AC-4: an UNLINKED Item stays visible read-only — no sync/mapping/unlink controls', async () => {
      items = [item({ status: 'UNLINKED' })];
      await renderPage();
      expect(screen.getByText('UNLINKED')).toBeDefined();
      expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Save mapping' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Unlink…' })).toBeNull();
      expect(screen.queryByLabelText('Map RBC Chequing')).toBeNull(); // mapping is history, not a choice
      expect(screen.getByText('Chequing')).toBeDefined(); // …but still shown for audit
    });
  });

  it('points at Settings when Plaid is not configured, with no link button offered', async () => {
    configured = false;
    items = [];
    const onBalances = vi.fn();
    render(
      <ConnectionsPage accounts={ACCOUNTS} onBalances={onBalances} onChanged={vi.fn()} linkLoader={linkLoader} />,
    );
    await screen.findByText(/Plaid is not configured yet/);
    expect(screen.queryByRole('button', { name: 'Add bank connection' })).toBeNull();
  });
});
