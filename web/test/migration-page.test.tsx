import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CSRF_HEADER, type MigrationResponse } from '@tyche/shared';
import { MigrationPage } from '../src/pages/MigrationPage.js';

/**
 * Component tests for the YNAB migration screen (E6). The migration semantics
 * are integration-tested server-side (server/test/migration); here `fetch` is
 * mocked to pin the UI contract: both files go up in ONE multipart request,
 * the parity + discrepancy report renders, and the empty-budget refusal shows
 * a friendly message instead of a raw code.
 */

const RESULT: MigrationResponse = {
  accountCount: 5,
  categoryGroupCount: 10,
  categoryCount: 30,
  payeeCount: 38,
  transactionCount: 104,
  transferCount: 8,
  splitCount: 2,
  assignmentCount: 115,
  discrepancies: [
    { source: 'register', line: 122, reason: 'unparseable amount: outflow "C$12.x4"' },
  ],
  parity: {
    month: '2026-06',
    ok: true,
    accounts: [
      {
        accountName: 'TFSA – 1676',
        sourceBalanceMilliunits: 13_095_670,
        importedBalanceMilliunits: 13_095_670,
        ok: true,
      },
    ],
    categories: [
      {
        groupName: 'Variable Spending',
        categoryName: 'Groceries',
        sourceAvailableMilliunits: 416_400,
        computedAvailableMilliunits: 416_400,
        ok: true,
      },
    ],
  },
  consistency: { ok: true, mismatches: [] },
};

let requests: { url: string; init: RequestInit }[];
let response: { ok: boolean; status: number; body: unknown };

beforeEach(() => {
  requests = [];
  response = { ok: true, status: 201, body: RESULT };
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      requests.push({ url, init });
      return Promise.resolve({
        ok: response.ok,
        status: response.status,
        json: () => Promise.resolve(response.body),
      } as Response);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function chooseFilesAndRun(): void {
  const register = new File(['register'], 'register.csv', { type: 'text/csv' });
  const plan = new File(['plan'], 'plan.csv', { type: 'text/csv' });
  fireEvent.change(screen.getByLabelText('Register CSV'), { target: { files: [register] } });
  fireEvent.change(screen.getByLabelText('Plan CSV'), { target: { files: [plan] } });
  fireEvent.click(screen.getByRole('button', { name: 'Run migration' }));
}

describe('MigrationPage', () => {
  it('uploads both CSVs in one request and renders the parity report', async () => {
    const onMigrated = vi.fn();
    render(<MigrationPage onMigrated={onMigrated} />);

    // Nothing runs until both files are chosen.
    expect(
      (screen.getByRole('button', { name: 'Run migration' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    chooseFilesAndRun();

    await waitFor(() => {
      expect(screen.getByText(/Migration complete/)).toBeTruthy();
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('/api/migration');
    expect(requests[0]!.init.method).toBe('POST');
    expect((requests[0]!.init.headers as Record<string, string>)[CSRF_HEADER]).toBe('1');
    const body = requests[0]!.init.body as FormData;
    expect((body.get('register') as File).name).toBe('register.csv');
    expect((body.get('plan') as File).name).toBe('plan.csv');

    expect(screen.getByText('parity verified to the cent')).toBeTruthy();
    expect(screen.getByText('TFSA – 1676')).toBeTruthy();
    expect(screen.getAllByText('$13095.67')).toHaveLength(2); // YNAB and imported columns
    expect(screen.getByText('Variable Spending: Groceries')).toBeTruthy();
    expect(screen.getByText(/unparseable amount/)).toBeTruthy();
    expect(screen.getByText(/104 transactions \(8 transfers, 2 splits\)/)).toBeTruthy();
    expect(onMigrated).toHaveBeenCalledTimes(1);
  });

  it('flags a failed parity check loudly', async () => {
    response.body = {
      ...RESULT,
      parity: { ...RESULT.parity, ok: false },
    };
    render(<MigrationPage onMigrated={() => undefined} />);
    chooseFilesAndRun();
    await waitFor(() => {
      expect(screen.getByText(/parity check FAILED/)).toBeTruthy();
    });
  });

  it('shows the friendly empty-budget refusal on 409 (FR-31)', async () => {
    response = { ok: false, status: 409, body: { error: 'budget_not_empty', accounts: 5 } };
    render(<MigrationPage onMigrated={() => undefined} />);
    chooseFilesAndRun();
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'Migration only runs into an empty budget',
      );
    });
  });
});
