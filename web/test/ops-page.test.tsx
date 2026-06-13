import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ConsistencyCheckResponse } from '@ynab-clone/shared';
import { OpsPage } from '../src/pages/OpsPage.js';

/**
 * E7 ops screen: backup button (S1 AC-1's UI half), export download links
 * (S2), and the consistency check — boot failure banner is LOUD (S4 AC-2),
 * on-demand run renders pass/mismatch list within the request (S4 AC-3).
 */

function bootReport(over: Partial<ConsistencyCheckResponse> = {}): ConsistencyCheckResponse {
  return {
    ok: true,
    mismatches: [],
    checkedAccounts: 3,
    checkedMonths: 6,
    throughMonth: '2026-06',
    ranAt: '2026-06-12T06:00:00.000Z',
    ...over,
  };
}

interface FetchCall {
  url: string;
  method: string;
}

function stubFetch(options: {
  boot: ConsistencyCheckResponse | null;
  run?: ConsistencyCheckResponse;
  calls?: FetchCall[];
}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      options.calls?.push({ url, method: init?.method ?? 'GET' });
      const json = (body: unknown): Response =>
        ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as Response;
      if (url === '/api/admin/consistency') return json({ boot: options.boot });
      if (url === '/api/admin/consistency/run') return json(options.run ?? bootReport());
      if (url === '/api/admin/backups')
        return json({
          backups: [{ name: 'ynab-clone-backup-20260612T060000Z.tar.gz', sizeBytes: 4096, createdAt: '2026-06-12T06:00:00.000Z' }],
        });
      if (url === '/api/admin/backup')
        return json({
          artifact: { name: 'ynab-clone-backup-20260612T070000Z.tar.gz', sizeBytes: 4096, createdAt: '2026-06-12T07:00:00.000Z' },
          pruned: [],
        });
      return { ok: false, status: 404, json: () => Promise.resolve({ error: 'not_found' }) } as Response;
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('OpsPage (E7)', () => {
  it('S4 AC-2: a failed boot check renders a loud banner; a passing one does not', async () => {
    stubFetch({ boot: bootReport({ ok: false, mismatches: ['2026-02 groceries activity: -1 vs -2'] }) });
    render(<OpsPage />);
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('consistency check FAILED at boot');

    cleanup();
    stubFetch({ boot: bootReport() });
    render(<OpsPage />);
    await screen.findByText(/Boot check .* passed/);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('S4 AC-3: Run consistency check posts and renders the pass with coverage', async () => {
    const calls: FetchCall[] = [];
    stubFetch({ boot: bootReport(), calls });
    render(<OpsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run consistency check' }));
    await screen.findByText(/Consistency check passed: 3 accounts and 6 months/);
    expect(calls).toContainEqual({ url: '/api/admin/consistency/run', method: 'POST' });
  });

  it('S4 AC-3: a mismatch renders the per-entity list with both values', async () => {
    stubFetch({
      boot: bootReport(),
      run: bootReport({ ok: false, mismatches: ['split parent abc: lines sum to -95000 vs parent total -90000'] }),
    });
    render(<OpsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run consistency check' }));
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('split parent abc: lines sum to -95000 vs parent total -90000');
  });

  it('S1: Back up now posts, confirms the artifact, and the list shows existing backups', async () => {
    const calls: FetchCall[] = [];
    stubFetch({ boot: bootReport(), calls });
    render(<OpsPage />);
    await screen.findByText('ynab-clone-backup-20260612T060000Z.tar.gz'); // the listing
    fireEvent.click(screen.getByRole('button', { name: 'Back up now' }));
    await screen.findByText(/Backup written: ynab-clone-backup-20260612T070000Z\.tar\.gz/);
    expect(calls).toContainEqual({ url: '/api/admin/backup', method: 'POST' });
    // The .env reminder is one line on the screen (ADR-007 / S1 dev note).
    expect(screen.getByText(/Remember: back up/).textContent).toContain(
      'separately — it is never inside the artifact',
    );
  });

  it('S2: export links point at the curl-able CSV endpoints', async () => {
    stubFetch({ boot: bootReport() });
    render(<OpsPage />);
    await screen.findByText(/No backups yet|ynab-clone-backup/);
    expect(screen.getByRole('link', { name: 'Download register CSV' }).getAttribute('href')).toBe(
      '/api/export/register.csv',
    );
    expect(screen.getByRole('link', { name: 'Download budget CSV' }).getAttribute('href')).toBe(
      '/api/export/budget.csv',
    );
  });
});
