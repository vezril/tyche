import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import {
  CSRF_HEADER,
  type CategorySummary,
  type ReviewItemResponse,
  type ReviewQueueResponse,
  type TransactionResponse,
} from '@tyche/shared';
import { ReviewPage } from '../src/pages/ReviewPage.js';

/**
 * Component tests for the review queue (E4.S2/S3). The API itself is
 * integration-tested in server/test/web/import-api.test.ts; here `fetch` is
 * mocked to pin the UI contract: listing with account/date/payee/suggestion/
 * amount, approve-with-edit posting only category/payee/memo (never amount or
 * date — AC-2), reject/unmatch wiring, match annotation (S3 AC-5), and the
 * keyboard loop (AC-3).
 */

const CATEGORIES: CategorySummary[] = [
  { id: 'cat-groceries', name: 'Groceries', groupId: 'g1', groupName: 'Everyday', isSystem: false },
  { id: 'cat-eating-out', name: 'Eating out', groupId: 'g1', groupName: 'Everyday', isSystem: false },
];

function txn(over: Partial<TransactionResponse>): TransactionResponse {
  return {
    id: 't1',
    accountId: 'a1',
    date: '2026-06-01',
    amountMilliunits: -52160,
    payeeId: 'p1',
    payeeName: 'TIM HORTONS #2241',
    categoryId: null,
    categoryName: null,
    memo: '',
    status: 'cleared',
    approved: false,
    source: 'file',
    isStartingBalance: false,
    lines: [],
    transferAccountId: null,
    transferAccountName: null,
    ...over,
  };
}

function item(over: Partial<ReviewItemResponse> & { transaction: TransactionResponse }): ReviewItemResponse {
  return {
    accountName: 'Chequing',
    match: null,
    suggestedCategoryId: null,
    suggestedCategoryName: null,
    ...over,
  };
}

let queue: ReviewItemResponse[];
let posts: { url: string; headers: Record<string, string>; body: unknown }[];
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}

beforeEach(() => {
  posts = [];
  queue = [
    item({
      transaction: txn({}),
      suggestedCategoryId: 'cat-eating-out',
      suggestedCategoryName: 'Eating out',
    }),
    item({
      transaction: txn({
        id: 't2',
        date: '2026-05-30',
        payeeName: 'Groceries run',
        categoryId: 'cat-groceries',
        categoryName: 'Groceries',
        memo: 'my own note',
        source: 'manual',
      }),
      match: {
        matchId: 'm1',
        importedDate: '2026-06-01',
        importedPayee: 'LOBLAWS 1034',
        importedAmountMilliunits: -52160,
        externalId: 'F1',
      },
    }),
  ];
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url === '/api/review') {
      return jsonResponse({ items: queue, totalCount: queue.length } satisfies ReviewQueueResponse);
    }
    if (method === 'POST') {
      posts.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body === undefined || init.body === null ? null : JSON.parse(String(init.body)),
      });
      queue = queue.filter((i) => !url.includes(i.transaction.id)); // acted-on rows leave the queue
      return jsonResponse({ transaction: txn({ approved: true }), accountBalances: [], rememberedExternalId: 'X' });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderQueue(): Promise<{ onBalances: ReturnType<typeof vi.fn>; onChanged: ReturnType<typeof vi.fn> }> {
  const onBalances = vi.fn();
  const onChanged = vi.fn();
  render(<ReviewPage categories={CATEGORIES} onBalances={onBalances} onChanged={onChanged} />);
  await screen.findByText('TIM HORTONS #2241');
  return { onBalances, onChanged };
}

describe('ReviewPage (E4.S2/S3)', () => {
  it('AC-1: lists unapproved rows with account, date, payee, suggested category, and amount', async () => {
    await renderQueue();
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    const first = within(rows[0]!);
    expect(first.getByText('Chequing')).toBeDefined();
    expect(first.getByText('2026-06-01')).toBeDefined();
    expect(first.getByText('$-52.16')).toBeDefined();
    // the suggestion is pre-selected in the category picker (FR-19)
    const select = first.getByLabelText(/Category for/) as HTMLSelectElement;
    expect(select.value).toBe('cat-eating-out');
  });

  it('AC-2: approving with edits posts ONLY category/payee/memo — never amount or date', async () => {
    await renderQueue();
    const rows = screen.getAllByRole('listitem');
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Edit memo'), { target: { value: 'double double' } });
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Approve' }));
    await screen.findByText(/Approved/);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe('/api/transactions/t1/approve');
    expect(posts[0]!.headers[CSRF_HEADER]).toBe('1');
    expect(posts[0]!.body).toEqual({
      categoryId: 'cat-eating-out',
      memo: 'double double',
      payeeName: 'TIM HORTONS #2241',
    });
  });

  it('AC-3: the keyboard loop works — J moves down, A approves, R rejects', async () => {
    const { onChanged } = await renderQueue();
    const region = screen.getByLabelText('Review imported transactions');
    fireEvent.keyDown(region, { key: 'j' });
    fireEvent.keyDown(region, { key: 'a' }); // approves the SECOND row (t2)
    await screen.findByText(/Approved/);
    expect(posts[0]!.url).toBe('/api/transactions/t2/approve');
    fireEvent.keyDown(region, { key: 'r' }); // rejects the remaining row (t1)
    await screen.findByText(/Rejected/);
    expect(posts[1]!.url).toBe('/api/transactions/t1/reject');
    expect(onChanged).toHaveBeenCalledTimes(2); // badge refresh after each action
  });

  it('S3 AC-5: a merged row is annotated with what the bank said, with Unmatch right there', async () => {
    await renderQueue();
    const matched = screen.getAllByRole('listitem')[1]!;
    expect(matched.className).toContain('matched');
    expect(within(matched).getByRole('note').textContent).toContain('LOBLAWS 1034');
    fireEvent.click(within(matched).getByRole('button', { name: 'Unmatch' }));
    await screen.findByText(/Unmatched/);
    expect(posts[0]!.url).toBe('/api/transactions/t2/unmatch');
  });

  it('shows the all-caught-up state when the queue is empty', async () => {
    queue = [];
    render(<ReviewPage categories={CATEGORIES} onBalances={vi.fn()} onChanged={vi.fn()} />);
    await screen.findByText(/all caught up/);
  });
});
