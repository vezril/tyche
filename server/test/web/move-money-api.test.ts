import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountResponse, BudgetMonthResponse } from '@tyche/shared';
import { INFLOW_READY_TO_ASSIGN_CATEGORY_ID } from '../../src/db/seed.js';
import { createTestRig, type TestRig } from './helpers.js';

// E3.S4 over HTTP: POST /api/budget/:month/move — a category→category move
// recorded as PAIRED assignment adjustments in one SQLite transaction (FR-5).
// RTA is untouched by construction: the two deltas cancel in the locked
// engine formula (AS-1) — no engine change, pure assignment arithmetic.

describe('move money API (E3.S4)', () => {
  let rig: TestRig;
  let chequing: AccountResponse;

  async function getMonth(month: string): Promise<BudgetMonthResponse> {
    const res = await rig.inject({ method: 'GET', url: `/api/budget/${month}` });
    expect(res.statusCode).toBe(200);
    return res.json() as BudgetMonthResponse;
  }

  async function putAssigned(month: string, categoryId: string, assigned: string): Promise<void> {
    const res = await rig.inject({
      method: 'PUT',
      url: `/api/budget/${month}/categories/${categoryId}`,
      payload: { assigned },
    });
    expect(res.statusCode).toBe(200);
  }

  async function move(
    month: string,
    payload: Record<string, unknown>,
  ): Promise<{ statusCode: number; body: BudgetMonthResponse }> {
    const res = await rig.inject({ method: 'POST', url: `/api/budget/${month}/move`, payload });
    return { statusCode: res.statusCode, body: res.json() as BudgetMonthResponse };
  }

  function categoryRow(payload: BudgetMonthResponse, categoryId: string) {
    const row = payload.groups
      .flatMap((g) => g.categories)
      .find((c) => c.categoryId === categoryId);
    expect(row, `category ${categoryId} in payload`).toBeDefined();
    return row!;
  }

  beforeEach(async () => {
    rig = await createTestRig();
    const res = await rig.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'Chequing', type: 'chequing', startingBalance: '0.00', startingDate: '2026-01-01' },
    });
    expect(res.statusCode).toBe(201);
    chequing = res.json() as AccountResponse;
    rig.db
      .prepare("INSERT INTO category_groups (id, name, sort_order) VALUES ('g1', 'Everyday', 1)")
      .run();
    const cat = rig.db.prepare(
      'INSERT INTO categories (id, group_id, name, sort_order, hidden) VALUES (?, ?, ?, ?, 0)',
    );
    cat.run('groceries', 'g1', 'Groceries', 1);
    cat.run('dining', 'g1', 'Dining', 2);
    const inflow = await rig.inject({
      method: 'POST',
      url: '/api/transactions',
      payload: {
        accountId: chequing.id,
        date: '2026-06-01',
        amount: '1000.00',
        payeeName: 'Employer',
        categoryId: INFLOW_READY_TO_ASSIGN_CATEGORY_ID,
      },
    });
    expect(inflow.statusCode).toBe(201);
  });
  afterEach(async () => {
    await rig.cleanup();
  });

  it('AC-1: moving $50 A→B drops A by $50, raises B by $50, leaves RTA unchanged', async () => {
    await putAssigned('2026-06', 'groceries', '200.00');
    await putAssigned('2026-06', 'dining', '100.00');
    const before = await getMonth('2026-06');
    expect(before.rtaMilliunits).toBe(700_000);

    const { statusCode, body } = await move('2026-06', {
      fromCategoryId: 'groceries',
      toCategoryId: 'dining',
      amount: '50.00',
    });
    expect(statusCode).toBe(200);

    // Paired assignment adjustments: source −50, destination +50 (FR-5).
    expect(categoryRow(body, 'groceries').assignedMilliunits).toBe(150_000);
    expect(categoryRow(body, 'groceries').availableMilliunits).toBe(150_000);
    expect(categoryRow(body, 'dining').assignedMilliunits).toBe(150_000);
    expect(categoryRow(body, 'dining').availableMilliunits).toBe(150_000);
    expect(body.rtaMilliunits).toBe(700_000); // untouched by construction
    expect(body.assignedThisMonthMilliunits).toBe(300_000);
  });

  it('AC-2: both adjustments are atomic — a bad destination leaves the source untouched', async () => {
    await putAssigned('2026-06', 'groceries', '200.00');
    const res = await move('2026-06', {
      fromCategoryId: 'groceries',
      toCategoryId: 'no-such-category',
      amount: '50.00',
    });
    expect(res.statusCode).toBe(404);
    expect(categoryRow(await getMonth('2026-06'), 'groceries').assignedMilliunits).toBe(200_000);
  });

  it('AC-3: a move that drives the source negative is permitted (warn client-side, never block)', async () => {
    await putAssigned('2026-06', 'groceries', '20.00');
    const { statusCode, body } = await move('2026-06', {
      fromCategoryId: 'groceries',
      toCategoryId: 'dining',
      amount: '50.00',
    });
    expect(statusCode).toBe(200);
    expect(categoryRow(body, 'groceries').availableMilliunits).toBe(-30_000);
    expect(categoryRow(body, 'dining').availableMilliunits).toBe(50_000);
    expect(body.rtaMilliunits).toBe(980_000);
  });

  it('AC-4: the paired adjustment survives a reload (stored as month_assignments rows)', async () => {
    await putAssigned('2026-06', 'groceries', '200.00');
    await move('2026-06', { fromCategoryId: 'groceries', toCategoryId: 'dining', amount: '75.00' });

    const reloaded = await getMonth('2026-06');
    expect(categoryRow(reloaded, 'groceries').assignedMilliunits).toBe(125_000);
    expect(categoryRow(reloaded, 'dining').assignedMilliunits).toBe(75_000);

    // Moving a category's whole assignment to exactly $0 leaves no zero-row residue.
    await move('2026-06', { fromCategoryId: 'groceries', toCategoryId: 'dining', amount: '125.00' });
    const rows = rig.db
      .prepare("SELECT * FROM month_assignments WHERE category_id = 'groceries'")
      .all();
    expect(rows).toEqual([]);
  });

  it('moves only touch the addressed month: other months see it via carryover, not assignment', async () => {
    await putAssigned('2026-05', 'groceries', '200.00');
    await move('2026-05', { fromCategoryId: 'groceries', toCategoryId: 'dining', amount: '50.00' });
    const june = await getMonth('2026-06');
    expect(categoryRow(june, 'groceries').assignedMilliunits).toBe(0);
    expect(categoryRow(june, 'groceries').carryoverMilliunits).toBe(150_000);
    expect(categoryRow(june, 'dining').carryoverMilliunits).toBe(50_000);
  });

  it('rejects non-positive and malformed amounts with 400', async () => {
    for (const amount of ['0', '-25.00', 'abc', '1.005']) {
      const res = await move('2026-06', {
        fromCategoryId: 'groceries',
        toCategoryId: 'dining',
        amount,
      });
      expect(res.statusCode, amount).toBe(400);
    }
  });

  it('rejects same-category moves, the inflow category, unknown categories, and bad months', async () => {
    const same = await move('2026-06', {
      fromCategoryId: 'groceries',
      toCategoryId: 'groceries',
      amount: '10.00',
    });
    expect(same.statusCode).toBe(400);

    for (const payload of [
      { fromCategoryId: INFLOW_READY_TO_ASSIGN_CATEGORY_ID, toCategoryId: 'dining', amount: '10.00' },
      { fromCategoryId: 'dining', toCategoryId: INFLOW_READY_TO_ASSIGN_CATEGORY_ID, amount: '10.00' },
    ]) {
      const res = await move('2026-06', payload);
      expect(res.statusCode).toBe(400); // RTA moves are a single assignment edit (E3.S3), not this endpoint
    }

    const unknownSource = await move('2026-06', {
      fromCategoryId: 'nope',
      toCategoryId: 'dining',
      amount: '10.00',
    });
    expect(unknownSource.statusCode).toBe(404);

    const badMonth = await move('2026-13', {
      fromCategoryId: 'groceries',
      toCategoryId: 'dining',
      amount: '10.00',
    });
    expect(badMonth.statusCode).toBe(400);
  });

  it('is behind the session wall and requires the CSRF header', async () => {
    const unauthed = await rig.app.inject({
      method: 'POST',
      url: '/api/budget/2026-06/move',
      headers: { 'x-tyche-csrf': '1' },
      payload: { fromCategoryId: 'groceries', toCategoryId: 'dining', amount: '10.00' },
    });
    expect(unauthed.statusCode).toBe(401);

    const noCsrf = await rig.app.inject({
      method: 'POST',
      url: '/api/budget/2026-06/move',
      headers: { cookie: rig.authed.cookie },
      payload: { fromCategoryId: 'groceries', toCategoryId: 'dining', amount: '10.00' },
    });
    expect(noCsrf.statusCode).toBe(403);
  });
});
