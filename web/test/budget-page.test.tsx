import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CSRF_HEADER, type BudgetCategoryMonth, type BudgetMonthResponse } from '@tyche/shared';
import BudgetPage from '../src/pages/BudgetPage.js';
import { currentMonth, nextMonth, prevMonth } from '../src/months.js';

/**
 * Component tests for the month grid (E3.S2) and cell editing (E3.S3).
 *
 * The API itself is integration-tested in server/test/web/budget-api.test.ts
 * (E3.S1); here `fetch` is mocked so the tests pin the UI logic: rendering
 * groups/subtotals from milliunits, month navigation URLs, and the
 * edit → optimistic update → server reconciliation loop.
 */

// --- fixture -----------------------------------------------------------------

const M0 = currentMonth(); // BudgetPage opens on the current month
const BOUNDS = { minMonth: prevMonth(prevMonth(M0)), maxMonth: nextMonth(M0) };

function cat(
  categoryId: string,
  name: string,
  v: { carryover?: number; assigned?: number; activity?: number },
): BudgetCategoryMonth {
  const carryover = v.carryover ?? 0;
  const assigned = v.assigned ?? 0;
  const activity = v.activity ?? 0;
  return {
    categoryId,
    name,
    carryoverMilliunits: carryover,
    assignedMilliunits: assigned,
    activityMilliunits: activity,
    availableMilliunits: carryover + assigned + activity, // FR-1
  };
}

function group(groupId: string, name: string, categories: BudgetCategoryMonth[]) {
  let assigned = 0;
  let activity = 0;
  let available = 0;
  for (const c of categories) {
    assigned += c.assignedMilliunits;
    activity += c.activityMilliunits;
    available += c.availableMilliunits;
  }
  return {
    groupId,
    name,
    assignedMilliunits: assigned,
    activityMilliunits: activity,
    availableMilliunits: available,
    categories,
  };
}

/** Rent $1200 spent exactly; Hydro overspent by $15; Eating Out has $45 left. */
function makeMonth(month: string): BudgetMonthResponse {
  return {
    month,
    rtaMilliunits: 100_000, // $100.00 left to assign
    inflowsMilliunits: 1_430_000,
    assignedThisMonthMilliunits: 1_330_000,
    overspendDeductedMilliunits: 0,
    groups: [
      group('grp-bills', 'Bills', [
        cat('cat-rent', 'Rent', { assigned: 1_200_000, activity: -1_200_000 }),
        cat('cat-hydro', 'Hydro', { assigned: 80_000, activity: -95_000 }),
      ]),
      group('grp-fun', 'Fun', [
        cat('cat-eat', 'Eating Out', { carryover: 25_000, assigned: 50_000, activity: -30_000 }),
      ]),
    ],
    bounds: { ...BOUNDS },
  };
}

// --- fetch mock ----------------------------------------------------------------

interface PutCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

let getPayload: (month: string) => BudgetMonthResponse;
let putResult: () => BudgetMonthResponse | Promise<BudgetMonthResponse>;
let putCalls: PutCall[];
let postResult: () => BudgetMonthResponse | Promise<BudgetMonthResponse>;
let postCalls: PutCall[];
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}

beforeEach(() => {
  getPayload = makeMonth;
  putResult = () => {
    throw new Error('putResult not configured for this test');
  };
  putCalls = [];
  postResult = () => {
    throw new Error('postResult not configured for this test');
  };
  postCalls = [];
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const getMatch = /^\/api\/budget\/(\d{4}-\d{2})$/.exec(url);
    if (method === 'GET' && getMatch) return jsonResponse(getPayload(getMatch[1]!));
    if (method === 'PUT') {
      putCalls.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)) as unknown,
      });
      return jsonResponse(await putResult());
    }
    if (method === 'POST') {
      postCalls.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)) as unknown,
      });
      return jsonResponse(await postResult());
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const requestedMonths = (): string[] =>
  fetchMock.mock.calls
    .filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET')
    .map(([input]) => /^\/api\/budget\/(\d{4}-\d{2})$/.exec(String(input))?.[1] ?? '?');

async function renderGrid(): Promise<void> {
  render(<BudgetPage />);
  await screen.findByLabelText('Assigned to Hydro');
}

const assignInput = (name: string): HTMLInputElement =>
  screen.getByLabelText(`Assigned to ${name}`) as HTMLInputElement;

const groupRow = (name: string): HTMLElement =>
  screen.getByRole('button', { name: new RegExp(name) }).closest('tr')!;

// --- E3.S2: the read grid ------------------------------------------------------

describe('BudgetPage month grid (E3.S2)', () => {
  it('AC-1: renders every category under its group, with subtotals equal to the category sums', async () => {
    await renderGrid();

    // Groups in payload order, categories beneath them.
    const rows = screen.getAllByRole('row').map((r) => r.textContent ?? '');
    const order = ['Bills', 'Rent', 'Hydro', 'Fun', 'Eating Out'].map((name) =>
      rows.findIndex((text) => text.includes(name)),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    // Milliunits → display formatting in the cells (ADR-004 at the UI edge).
    expect(assignInput('Rent').value).toBe('1200.00');
    expect(assignInput('Hydro').value).toBe('80.00');
    const hydroRow = assignInput('Hydro').closest('tr')!;
    expect(within(hydroRow).getByText('$-95.00')).toBeTruthy(); // activity
    expect(within(hydroRow).getByText('$-15.00')).toBeTruthy(); // available

    // Group subtotal row = sum of its categories ($1280 / $-1295 / $-15).
    const bills = groupRow('Bills');
    expect(within(bills).getByText('$1280.00')).toBeTruthy();
    expect(within(bills).getByText('$-1295.00')).toBeTruthy();
    expect(within(bills).getByText('$-15.00')).toBeTruthy();
  });

  it('AC-3: Ready to Assign is prominently displayed from the payload', async () => {
    await renderGrid();
    const banner = screen.getByLabelText('Ready to Assign');
    expect(banner.textContent).toContain('$100.00');
    expect(banner.className).not.toContain('negative');
  });

  it('overspent available (negative) is styled distinctly', async () => {
    await renderGrid();
    const hydroRow = assignInput('Hydro').closest('tr')!;
    const pill = within(hydroRow).getByText('$-15.00');
    expect(pill.className).toContain('negative');
    const eatRow = assignInput('Eating Out').closest('tr')!;
    expect(within(eatRow).getByText('$45.00').className).toContain('positive');
  });

  it('AC-2: prev/next navigation fetches each month and disables at the bounds', async () => {
    await renderGrid();
    expect(requestedMonths()).toEqual([M0]);

    const next = screen.getByLabelText('Next month');
    const prev = screen.getByLabelText('Previous month');

    fireEvent.click(next);
    await waitFor(() => expect(requestedMonths()).toEqual([M0, nextMonth(M0)]));
    // Now at bounds.maxMonth — the future planning month is reachable, then stop.
    await waitFor(() => expect((next as HTMLButtonElement).disabled).toBe(true));

    fireEvent.click(prev);
    fireEvent.click(prev);
    fireEvent.click(prev);
    await waitFor(() =>
      expect(requestedMonths()).toEqual([
        M0,
        nextMonth(M0),
        M0,
        prevMonth(M0),
        prevMonth(prevMonth(M0)),
      ]),
    );
    // At bounds.minMonth, previous is disabled.
    await waitFor(() => expect((prev as HTMLButtonElement).disabled).toBe(true));
  });

  it('AC-2: direct month jump clamps into the navigable bounds', async () => {
    await renderGrid();
    fireEvent.change(screen.getByLabelText('Jump to month'), { target: { value: '2099-01' } });
    await waitFor(() => expect(requestedMonths()).toEqual([M0, BOUNDS.maxMonth]));
    fireEvent.change(screen.getByLabelText('Jump to month'), { target: { value: '1990-01' } });
    await waitFor(() =>
      expect(requestedMonths()).toEqual([M0, BOUNDS.maxMonth, BOUNDS.minMonth]),
    );
  });

  it('collapsing a group hides its category rows but keeps the subtotal', async () => {
    await renderGrid();
    fireEvent.click(screen.getByRole('button', { name: /Bills/ }));
    expect(screen.queryByLabelText('Assigned to Rent')).toBeNull();
    expect(screen.queryByLabelText('Assigned to Hydro')).toBeNull();
    expect(within(groupRow('Bills')).getByText('$1280.00')).toBeTruthy();
    // Other groups untouched; expanding restores the rows.
    expect(screen.getByLabelText('Assigned to Eating Out')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Bills/ }));
    expect(screen.getByLabelText('Assigned to Rent')).toBeTruthy();
  });

  it('AC-6: assigned cells are keyboard-focusable; arrows move between rows', async () => {
    await renderGrid();
    const rent = assignInput('Rent');
    rent.focus();
    expect(document.activeElement).toBe(rent);
    fireEvent.keyDown(rent, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(assignInput('Hydro'));
    // Across the group boundary too…
    fireEvent.keyDown(assignInput('Hydro'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(assignInput('Eating Out'));
    // …and back up.
    fireEvent.keyDown(assignInput('Eating Out'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(assignInput('Hydro'));
    expect(putCalls).toEqual([]); // unchanged cells never call the API
  });
});

// --- E3.S3: cell editing ---------------------------------------------------------

describe('BudgetPage assign editing (E3.S3)', () => {
  it('AC-1/AC-2: Enter commits a PUT, updates RTA + available optimistically, then reconciles from the server', async () => {
    let resolvePut!: (r: BudgetMonthResponse) => void;
    putResult = () => new Promise<BudgetMonthResponse>((res) => (resolvePut = res));
    await renderGrid();

    const hydro = assignInput('Hydro');
    fireEvent.focus(hydro);
    fireEvent.change(hydro, { target: { value: '250.00' } });
    fireEvent.keyDown(hydro, { key: 'Enter' });

    // PUT issued with the CSRF header and the canonical dollars string.
    await waitFor(() => expect(putCalls.length).toBe(1));
    expect(putCalls[0]!.url).toBe(`/api/budget/${M0}/categories/cat-hydro`);
    expect(putCalls[0]!.body).toEqual({ assigned: '250.00' });
    expect(putCalls[0]!.headers[CSRF_HEADER]).toBe('1');

    // Optimistic state, before the server answers (delta = +$170):
    // available -15 → 155, RTA 100 → -70, group subtotals follow.
    expect(hydro.value).toBe('250.00');
    const hydroRow = hydro.closest('tr')!;
    expect(within(hydroRow).getByText('$155.00')).toBeTruthy();
    const banner = screen.getByLabelText('Ready to Assign');
    expect(banner.textContent).toContain('$-70.00');
    expect(banner.className).toContain('negative');
    expect(within(groupRow('Bills')).getByText('$1450.00')).toBeTruthy();

    // The server's recomputed payload wins, even where it disagrees.
    const serverTruth = makeMonth(M0);
    serverTruth.groups[0]!.categories[1] = cat('cat-hydro', 'Hydro', {
      assigned: 250_000,
      activity: -95_000,
    });
    serverTruth.rtaMilliunits = -77_000; // deliberately ≠ the optimistic -70
    resolvePut(serverTruth);
    await waitFor(() =>
      expect(screen.getByLabelText('Ready to Assign').textContent).toContain('$-77.00'),
    );
    expect(assignInput('Hydro').value).toBe('250.00');
  });

  it('AC-1: the committed value survives a reload (server state, verified via remount)', async () => {
    const serverTruth = makeMonth(M0);
    serverTruth.groups[0]!.categories[1] = cat('cat-hydro', 'Hydro', {
      assigned: 250_000,
      activity: -95_000,
    });
    putResult = () => serverTruth;
    await renderGrid();

    const hydro = assignInput('Hydro');
    fireEvent.focus(hydro);
    fireEvent.change(hydro, { target: { value: '250.00' } });
    fireEvent.keyDown(hydro, { key: 'Enter' });
    await waitFor(() => expect(putCalls.length).toBe(1));

    // "Reload": tear the app down and mount it fresh — only server state survives.
    cleanup();
    getPayload = () => serverTruth;
    await renderGrid();
    expect(assignInput('Hydro').value).toBe('250.00');
    expect(fetchMock.mock.calls.filter(([, i]) => (i as RequestInit)?.method === 'PUT')).toHaveLength(1);
  });

  it('AC-3: blur (Tab/arrow focus moves) also commits a changed cell', async () => {
    const serverTruth = makeMonth(M0);
    putResult = () => serverTruth;
    await renderGrid();

    const hydro = assignInput('Hydro');
    fireEvent.focus(hydro);
    fireEvent.change(hydro, { target: { value: '90.00' } });
    fireEvent.blur(hydro);
    await waitFor(() => expect(putCalls.length).toBe(1));
    expect(putCalls[0]!.body).toEqual({ assigned: '90.00' });
  });

  it('Escape cancels the edit: value reverts, no API call', async () => {
    await renderGrid();
    const hydro = assignInput('Hydro');
    fireEvent.focus(hydro);
    fireEvent.change(hydro, { target: { value: '999.99' } });
    fireEvent.keyDown(hydro, { key: 'Escape' });
    expect(assignInput('Hydro').value).toBe('80.00');
    fireEvent.blur(hydro); // post-cancel blur must not commit the dead draft
    expect(putCalls).toEqual([]);
  });

  it('invalid input shows an inline error and never reaches the API', async () => {
    await renderGrid();
    const hydro = assignInput('Hydro');
    fireEvent.focus(hydro);
    fireEvent.change(hydro, { target: { value: 'lots' } });
    fireEvent.keyDown(hydro, { key: 'Enter' });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('dollars-and-cents');
    expect(putCalls).toEqual([]);
    // Sub-cent precision is rejected too (FR-32: whole cents only).
    fireEvent.change(hydro, { target: { value: '1.234' } });
    fireEvent.keyDown(hydro, { key: 'Enter' });
    expect(putCalls).toEqual([]);
  });

  it('AC-5: clearing a cell commits $0 (unassign)', async () => {
    putResult = () => makeMonth(M0);
    await renderGrid();
    const hydro = assignInput('Hydro');
    fireEvent.focus(hydro);
    fireEvent.change(hydro, { target: { value: '' } });
    fireEvent.keyDown(hydro, { key: 'Enter' });
    await waitFor(() => expect(putCalls.length).toBe(1));
    expect(putCalls[0]!.body).toEqual({ assigned: '0.00' });
  });

  it('committing an unchanged value is a no-op (no API call)', async () => {
    await renderGrid();
    const hydro = assignInput('Hydro');
    fireEvent.focus(hydro);
    fireEvent.keyDown(hydro, { key: 'Enter' });
    fireEvent.blur(hydro);
    expect(putCalls).toEqual([]);
  });
});

// --- E3.S4: move money between categories ------------------------------------

const openMover = (name: string): HTMLElement => {
  fireEvent.click(screen.getByLabelText(`Move money (${name})`));
  return screen.getByRole('dialog');
};

describe('BudgetPage move money (E3.S4)', () => {
  it('AC-1/AC-2: the popover moves $15 to overspent Hydro — POST, optimistic paired update, RTA unchanged, then server reconciliation', async () => {
    let resolvePost!: (r: BudgetMonthResponse) => void;
    postResult = () => new Promise<BudgetMonthResponse>((res) => (resolvePost = res));
    await renderGrid();

    // Opened from the overspent category: default direction is "to" (cover it).
    const dialog = openMover('Hydro');
    // The picker shows the other categories WITH their current availables (AC-2).
    const picker = within(dialog).getByLabelText('Other category') as HTMLSelectElement;
    const optionTexts = [...picker.options].map((o) => o.textContent);
    expect(optionTexts).toContain('Eating Out ($45.00)');
    expect(optionTexts).toContain('Rent ($0.00)');
    expect(optionTexts).not.toContain('Hydro ($-15.00)'); // never itself

    fireEvent.change(picker, { target: { value: 'cat-eat' } });
    fireEvent.change(within(dialog).getByLabelText('Move amount'), { target: { value: '15.00' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));

    await waitFor(() => expect(postCalls.length).toBe(1));
    expect(postCalls[0]!.url).toBe(`/api/budget/${M0}/move`);
    expect(postCalls[0]!.body).toEqual({
      fromCategoryId: 'cat-eat',
      toCategoryId: 'cat-hydro',
      amount: '15.00',
    });
    expect(postCalls[0]!.headers[CSRF_HEADER]).toBe('1');

    // Optimistic paired adjustment before the server answers:
    // Hydro available -15 → 0, Eating Out 45 → 30, RTA untouched at $100.
    expect(screen.queryByRole('dialog')).toBeNull(); // popover closed on commit
    const hydroRow = assignInput('Hydro').closest('tr')!;
    expect(within(hydroRow).getByText('$0.00')).toBeTruthy();
    expect(assignInput('Hydro').value).toBe('95.00'); // assigned 80 + 15
    const eatRow = assignInput('Eating Out').closest('tr')!;
    expect(within(eatRow).getByText('$30.00')).toBeTruthy();
    expect(assignInput('Eating Out').value).toBe('35.00'); // assigned 50 − 15
    expect(screen.getByLabelText('Ready to Assign').textContent).toContain('$100.00');

    // The server's recomputed month wins, even where it disagrees.
    const serverTruth = makeMonth(M0);
    serverTruth.rtaMilliunits = 99_000;
    resolvePost(serverTruth);
    await waitFor(() =>
      expect(screen.getByLabelText('Ready to Assign').textContent).toContain('$99.00'),
    );
  });

  it('direction "from" swaps source and destination in the POST', async () => {
    postResult = () => makeMonth(M0);
    await renderGrid();
    const dialog = openMover('Eating Out');
    fireEvent.change(within(dialog).getByLabelText('Direction'), { target: { value: 'from' } });
    fireEvent.change(within(dialog).getByLabelText('Other category'), {
      target: { value: 'cat-hydro' },
    });
    fireEvent.change(within(dialog).getByLabelText('Move amount'), { target: { value: '10.00' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(postCalls.length).toBe(1));
    expect(postCalls[0]!.body).toEqual({
      fromCategoryId: 'cat-eat',
      toCategoryId: 'cat-hydro',
      amount: '10.00',
    });
  });

  it('AC-3: a move that would drive the source negative warns but does not block', async () => {
    postResult = () => makeMonth(M0);
    await renderGrid();
    const dialog = openMover('Hydro');
    fireEvent.change(within(dialog).getByLabelText('Other category'), {
      target: { value: 'cat-eat' },
    });
    fireEvent.change(within(dialog).getByLabelText('Move amount'), { target: { value: '60.00' } });

    // Eating Out has $45 available — moving $60 overspends it by $15. Warn only.
    const warning = within(dialog).getByRole('status');
    expect(warning.textContent).toContain('overspend');
    expect(warning.textContent).toContain('$15.00');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(postCalls.length).toBe(1)); // never blocked
  });

  it('invalid or non-positive amounts never reach the API', async () => {
    await renderGrid();
    const dialog = openMover('Hydro');
    for (const value of ['nope', '0', '-5.00']) {
      fireEvent.change(within(dialog).getByLabelText('Move amount'), { target: { value } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
      expect(within(dialog).getByRole('alert').textContent).toBeTruthy();
    }
    expect(postCalls).toEqual([]);
  });

  it('AC-5: the flow is keyboard-operable — the trigger is a button, Escape closes without a call', async () => {
    await renderGrid();
    const trigger = screen.getByLabelText('Move money (Hydro)');
    expect(trigger.tagName).toBe('BUTTON');
    fireEvent.click(trigger);
    const amount = within(screen.getByRole('dialog')).getByLabelText('Move amount');
    expect(document.activeElement).toBe(amount); // focus lands in the dialog
    fireEvent.keyDown(amount, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(postCalls).toEqual([]);
    // Cancel button closes too.
    fireEvent.click(screen.getByLabelText('Move money (Hydro)'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

// --- E3.S5: RTA indicator states + overspend styling ---------------------------

describe('BudgetPage RTA indicator states (E3.S5)', () => {
  it('AC-2: positive RTA shows the distinct "unassigned money" state prompting assignment', async () => {
    await renderGrid(); // fixture RTA = $100.00
    const banner = screen.getByLabelText('Ready to Assign');
    expect(banner.className).toContain('positive');
    expect(banner.textContent).toContain('$100.00');
    expect(banner.textContent).toContain('Ready to Assign');
  });

  it('AC-1: negative RTA shows the over-assigned warning state with the negative amount', async () => {
    getPayload = (month) => ({ ...makeMonth(month), rtaMilliunits: -70_000 });
    await renderGrid();
    const banner = screen.getByLabelText('Ready to Assign');
    expect(banner.className).toContain('negative');
    expect(banner.textContent).toContain('$-70.00');
    expect(banner.textContent).toContain('Over-assigned');
  });

  it('AC-5: RTA exactly $0 shows the "every dollar assigned" success state', async () => {
    getPayload = (month) => ({ ...makeMonth(month), rtaMilliunits: 0 });
    await renderGrid();
    const banner = screen.getByLabelText('Ready to Assign');
    expect(banner.className).toContain('zero');
    expect(banner.textContent).toContain('$0.00');
    expect(banner.textContent).toContain('Every dollar assigned');
  });

  it('AC-1: committing an over-assignment is warned about, never blocked (PUT still issued)', async () => {
    const serverTruth = { ...makeMonth(M0), rtaMilliunits: -150_000 };
    putResult = () => serverTruth;
    await renderGrid();
    const hydro = assignInput('Hydro');
    fireEvent.focus(hydro);
    fireEvent.change(hydro, { target: { value: '330.00' } }); // +$250 > RTA $100
    fireEvent.keyDown(hydro, { key: 'Enter' });
    await waitFor(() => expect(putCalls.length).toBe(1)); // not blocked
    await waitFor(() =>
      expect(screen.getByLabelText('Ready to Assign').className).toContain('negative'),
    );
  });

  it('AC-3: overspent availables render in the distinct overspent style (FR-7)', async () => {
    await renderGrid();
    const hydroRow = assignInput('Hydro').closest('tr')!;
    const pill = within(hydroRow).getByText('$-15.00');
    expect(pill.className).toContain('negative');
  });
});
