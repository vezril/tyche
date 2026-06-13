import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PlaidItemResponse } from '@ynab-clone/shared';
import { SyncBanner } from '../src/pages/SyncBanner.js';
import { AuthProvider } from '../src/auth.js';
import { Shell } from '../src/App.js';

/**
 * E5.S4 AC-1/AC-5 (FR-26): the broken-connection banner — prominent,
 * persistent, app-wide. Component tests pin its content and the direct
 * re-link action; the shell test pins that it renders on a NON-connections
 * view (the budget grid), i.e. genuinely app-wide.
 */

function item(over: Partial<PlaidItemResponse> = {}): PlaidItemResponse {
  return {
    id: 'item-1',
    institutionName: 'RBC Royal Bank',
    status: 'NEEDS_RELINK',
    accounts: [],
    lastAttempt: {
      at: '2026-06-12T06:00:00Z',
      outcome: 'error',
      addedCount: 0,
      updatedCount: 0,
      removedCount: 0,
      errorCode: 'ITEM_LOGIN_REQUIRED',
      message: null,
    },
    lastSuccessAt: '2026-06-11T06:00:00Z',
    syncLog: [],
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SyncBanner (E5.S4)', () => {
  it('renders nothing while every connection is healthy', () => {
    const { container } = render(
      <SyncBanner items={[item({ status: 'ACTIVE' }), item({ id: 'i2', status: 'UNLINKED' })]} onRelink={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('AC-1: names the broken connection and shows its last-successful-sync time', () => {
    render(<SyncBanner items={[item()]} onRelink={vi.fn()} />);
    const banner = screen.getByRole('alert');
    expect(banner.textContent).toContain('RBC Royal Bank needs to be re-linked.');
    expect(banner.textContent).toContain('last successful sync 2026-06-11T06:00:00Z');
    expect(banner.textContent).toContain('import an OFX/CSV file'); // the documented fallback (E4.S1)
  });

  it('says so when the connection has never synced successfully', () => {
    render(<SyncBanner items={[item({ lastSuccessAt: null })]} onRelink={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toContain('never synced successfully');
  });

  it('AC-5: links directly to the re-link action', () => {
    const onRelink = vi.fn();
    render(<SyncBanner items={[item()]} onRelink={onRelink} />);
    fireEvent.click(screen.getByRole('button', { name: 'Re-link now' }));
    expect(onRelink).toHaveBeenCalledWith('item-1');
  });
});

describe('the banner is app-wide (shell-level, E5.S4 AC-1)', () => {
  it('shows on the budget view — not just the connections screen', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        const json = (body: unknown): Response =>
          ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as Response;
        if (url === '/api/auth/status') return json({ setupRequired: false, authenticated: true });
        if (url.startsWith('/api/accounts')) return json({ accounts: [] });
        if (url === '/api/categories') return json({ categories: [] });
        if (url === '/api/review') return json({ transactions: [], totalCount: 0 });
        if (url === '/api/plaid/items') return json({ items: [item()] });
        // the lazy budget grid's data — irrelevant here, let it error politely
        return { ok: false, status: 404, json: () => Promise.resolve({ error: 'not_found' }) } as Response;
      }),
    );
    render(
      <AuthProvider>
        <Shell />
      </AuthProvider>,
    );
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('RBC Royal Bank needs to be re-linked.');
    // and we really are on the budget view, not connections
    const budgetTab = screen.getByRole('button', { name: 'Budget' });
    expect(budgetTab.getAttribute('aria-current')).toBe('page');
  });
});
