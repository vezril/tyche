import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CSRF_HEADER, type CategoryStructureResponse } from '@tyche/shared';
import { CategoriesPage } from '../src/pages/CategoriesPage.js';

/**
 * Component tests for the budget-structure management screen (E3.S6, FR-9).
 * The API behaviour is integration-tested in server/test/web/categories-api
 * .test.ts; here `fetch` is mocked to pin the UI logic: rendering the
 * structure, the create/rename/reorder/hide flows, and the delete flow that
 * answers a 409 with the required reassignment picker (AC-4).
 */

function makeStructure(): CategoryStructureResponse {
  return {
    groups: [
      {
        id: 'g-bills',
        name: 'Bills',
        hidden: false,
        categories: [
          { id: 'cat-rent', name: 'Rent', hidden: false },
          { id: 'cat-hydro', name: 'Hydro', hidden: true },
        ],
      },
      {
        id: 'g-fun',
        name: 'Fun',
        hidden: false,
        categories: [{ id: 'cat-eat', name: 'Eating Out', hidden: false }],
      },
    ],
  };
}

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

let structure: CategoryStructureResponse;
let calls: Call[];
let mutationResult: () => { status: number; body: unknown };
let onChanged: ReturnType<typeof vi.fn>;

beforeEach(() => {
  structure = makeStructure();
  calls = [];
  mutationResult = () => ({ status: 200, body: makeStructure() });
  onChanged = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url === '/api/categories/structure') {
        return { ok: true, status: 200, json: () => Promise.resolve(structure) } as Response;
      }
      calls.push({
        method,
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body == null ? null : (JSON.parse(String(init.body)) as unknown),
      });
      const { status, body } = mutationResult();
      return {
        ok: status < 400,
        status,
        json: () => Promise.resolve(body),
      } as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderPage(): Promise<void> {
  render(<CategoriesPage onChanged={onChanged} />);
  await screen.findByText('Rent');
}

describe('CategoriesPage (E3.S6)', () => {
  it('renders groups with their categories in order, marking hidden rows', async () => {
    await renderPage();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings.some((t) => t?.includes('Bills'))).toBe(true);
    expect(headings.some((t) => t?.includes('Fun'))).toBe(true);
    // Hidden categories stay listed (AC-3: unhide must be reachable) and are marked.
    const hydroRow = screen.getByText('Hydro').closest('li')!;
    expect(within(hydroRow).getByText('(hidden)')).toBeTruthy();
    expect(within(hydroRow).getByRole('button', { name: 'Unhide Hydro' })).toBeTruthy();
  });

  it('AC-1: creating a group and a category POSTs and re-renders from the server response', async () => {
    const grown = makeStructure();
    grown.groups.push({ id: 'g-new', name: 'Savings', hidden: false, categories: [] });
    mutationResult = () => ({ status: 201, body: grown });
    await renderPage();

    fireEvent.change(screen.getByLabelText('New group name'), { target: { value: 'Savings' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add group' }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: '/api/category-groups',
      body: { name: 'Savings' },
    });
    expect(calls[0]!.headers[CSRF_HEADER]).toBe('1');
    await screen.findAllByText(/Savings/); // group heading + the move-to-group pickers
    expect(onChanged).toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('New category in Bills'), {
      target: { value: 'Internet' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add category to Bills' }));
    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1]).toMatchObject({
      method: 'POST',
      url: '/api/categories',
      body: { groupId: 'g-bills', name: 'Internet' },
    });
  });

  it('AC-1: renaming a category is an inline edit committed with Enter', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Rename Rent' }));
    const input = screen.getByLabelText('Rename Rent') as HTMLInputElement;
    expect(input.value).toBe('Rent');
    fireEvent.change(input, { target: { value: 'Mortgage' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      url: '/api/categories/cat-rent',
      body: { name: 'Mortgage' },
    });
  });

  it('AC-2: up/down buttons PATCH the new index; edges are disabled (keyboard reordering)', async () => {
    await renderPage();
    expect(
      (screen.getByRole('button', { name: 'Move Rent up' }) as HTMLButtonElement).disabled,
    ).toBe(true); // already first
    fireEvent.click(screen.getByRole('button', { name: 'Move Rent down' }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      url: '/api/categories/cat-rent',
      body: { index: 1 },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Move Fun up' }));
    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1]).toMatchObject({
      method: 'PATCH',
      url: '/api/category-groups/g-fun',
      body: { index: 0 },
    });
  });

  it('AC-2: a category can be sent to another group', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText('Move Rent to group'), {
      target: { value: 'g-fun' },
    });
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      url: '/api/categories/cat-rent',
      body: { groupId: 'g-fun' },
    });
  });

  it('AC-3: hide and unhide PATCH the hidden flag', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Hide Rent' }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      url: '/api/categories/cat-rent',
      body: { hidden: true },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unhide Hydro' }));
    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1]).toMatchObject({ body: { hidden: false } });
  });

  it('AC-5: deleting a category without history needs no target', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Rent' }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: '/api/categories/cat-rent' });
    expect(onChanged).toHaveBeenCalled();
  });

  it('AC-4: a 409 opens the required reassignment picker; confirming retries with the target', async () => {
    mutationResult = () => ({ status: 409, body: { error: 'reassignment_required' } });
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Rent' }));

    const picker = (await screen.findByLabelText('Reassign Rent history to')) as HTMLSelectElement;
    // Targets are every OTHER category, never the one being deleted.
    const options = [...picker.options].map((o) => o.value);
    expect(options).toContain('cat-hydro');
    expect(options).toContain('cat-eat');
    expect(options).not.toContain('cat-rent');

    mutationResult = () => ({ status: 200, body: makeStructure() });
    fireEvent.change(picker, { target: { value: 'cat-eat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reassign and delete' }));
    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1]).toMatchObject({
      method: 'DELETE',
      url: '/api/categories/cat-rent?reassignTo=cat-eat',
    });
  });

  it('group delete on a non-empty group surfaces the server error', async () => {
    mutationResult = () => ({ status: 400, body: { error: 'group_not_empty' } });
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Bills' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/empty/i);
  });
});
