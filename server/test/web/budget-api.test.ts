import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AccountResponse,
  BudgetMonthResponse,
  TransactionMutationResponse,
} from '@ynab-clone/shared';
import { INFLOW_READY_TO_ASSIGN_CATEGORY_ID } from '../../src/db/seed.js';
import { createTestRig, type TestRig } from './helpers.js';

// E3.S1 over HTTP: GET /api/budget/:month (the grid payload E3.S2 renders)
// and PUT /api/budget/:month/categories/:categoryId (the assignment upsert
// E3.S3 drives). Dollar strings in, milliunits out (ADR-004); every number
// recomputed from raw rows on the way out (ADR-005).

describe('budget API (E3.S1)', () => {
  let rig: TestRig;
  let chequing: AccountResponse;

  const currentMonth = (): string => new Date().toISOString().slice(0, 7);

  async function createAccount(
    name: string,
    type: 'chequing' | 'savings' | 'tracking',
    startingBalance = '0.00',
  ): Promise<AccountResponse> {
    const res = await rig.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name, type, startingBalance, startingDate: '2026-01-01' },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as AccountResponse;
  }

  async function addTransaction(payload: Record<string, unknown>): Promise<TransactionMutationResponse> {
    const res = await rig.inject({ method: 'POST', url: '/api/transactions', payload });
    expect(res.statusCode).toBe(201);
    return res.json() as TransactionMutationResponse;
  }

  async function getMonth(month: string): Promise<BudgetMonthResponse> {
    const res = await rig.inject({ method: 'GET', url: `/api/budget/${month}` });
    expect(res.statusCode).toBe(200);
    return res.json() as BudgetMonthResponse;
  }

  async function putAssigned(
    month: string,
    categoryId: string,
    assigned: string,
  ): Promise<BudgetMonthResponse> {
    const res = await rig.inject({
      method: 'PUT',
      url: `/api/budget/${month}/categories/${categoryId}`,
      payload: { assigned },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as BudgetMonthResponse;
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
    chequing = await createAccount('Chequing', 'chequing');
    rig.db
      .prepare("INSERT INTO category_groups (id, name, sort_order) VALUES ('g1', 'Everyday', 1)")
      .run();
    rig.db
      .prepare("INSERT INTO category_groups (id, name, sort_order) VALUES ('g2', 'Bills', 2)")
      .run();
    const cat = rig.db.prepare(
      'INSERT INTO categories (id, group_id, name, sort_order, hidden) VALUES (?, ?, ?, ?, ?)',
    );
    cat.run('groceries', 'g1', 'Groceries', 1, 0);
    cat.run('dining', 'g1', 'Dining', 2, 0);
    cat.run('secret', 'g1', 'Hidden cat', 3, 1);
    cat.run('hydro', 'g2', 'Hydro', 1, 0);
  });
  afterEach(async () => {
    await rig.cleanup();
  });

  describe('GET /api/budget/:month — payload shape (for E3.S2)', () => {
    it('returns visible groups in order with per-category values, rollups, RTA, and bounds', async () => {
      await addTransaction({
        accountId: chequing.id,
        date: '2026-06-01',
        amount: '1000.00',
        payeeName: 'Employer',
        categoryId: INFLOW_READY_TO_ASSIGN_CATEGORY_ID,
      });
      await addTransaction({
        accountId: chequing.id,
        date: '2026-06-10',
        amount: '-45.20',
        payeeName: 'Loblaws',
        categoryId: 'groceries',
      });
      await putAssigned('2026-06', 'groceries', '200.00');

      const payload = await getMonth('2026-06');
      expect(payload.month).toBe('2026-06');
      // System group (hidden) and hidden categories are excluded; order preserved.
      expect(payload.groups.map((g) => g.name)).toEqual(['Everyday', 'Bills']);
      expect(payload.groups[0]!.categories.map((c) => c.name)).toEqual(['Groceries', 'Dining']);

      const groceries = categoryRow(payload, 'groceries');
      expect(groceries).toEqual({
        categoryId: 'groceries',
        name: 'Groceries',
        carryoverMilliunits: 0,
        assignedMilliunits: 200_000,
        activityMilliunits: -45_200,
        availableMilliunits: 154_800,
      });

      // Group rollups are the sums of their categories.
      const everyday = payload.groups[0]!;
      expect(everyday.assignedMilliunits).toBe(200_000);
      expect(everyday.activityMilliunits).toBe(-45_200);
      expect(everyday.availableMilliunits).toBe(154_800);

      expect(payload.rtaMilliunits).toBe(800_000); // 1000 inflow − 200 assigned
      expect(payload.inflowsMilliunits).toBe(1_000_000);
      expect(payload.assignedThisMonthMilliunits).toBe(200_000);
      expect(payload.overspendDeductedMilliunits).toBe(0);

      // Bounds: earliest data month → one month past the latest of (data, today).
      expect(payload.bounds.minMonth).toBe('2026-01'); // the starting-balance row
      const today = currentMonth();
      const latest = today > '2026-06' ? today : '2026-06';
      const [y, m] = latest.split('-').map(Number) as [number, number];
      const expectedMax = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
      expect(payload.bounds.maxMonth).toBe(expectedMax);
    });

    it('AC-1: $50 carryover + $200 assigned + −$120 activity → available is exactly 130_000', async () => {
      // May: assign $50, no spending → May available +$50 → June carryover $50.
      await addTransaction({
        accountId: chequing.id,
        date: '2026-05-01',
        amount: '500.00',
        payeeName: 'Employer',
        categoryId: INFLOW_READY_TO_ASSIGN_CATEGORY_ID,
      });
      await putAssigned('2026-05', 'groceries', '50.00');
      await putAssigned('2026-06', 'groceries', '200.00');
      await addTransaction({
        accountId: chequing.id,
        date: '2026-06-15',
        amount: '-120.00',
        payeeName: 'Loblaws',
        categoryId: 'groceries',
      });

      const groceries = categoryRow(await getMonth('2026-06'), 'groceries');
      expect(groceries.carryoverMilliunits).toBe(50_000);
      expect(groceries.assignedMilliunits).toBe(200_000);
      expect(groceries.activityMilliunits).toBe(-120_000);
      expect(groceries.availableMilliunits).toBe(130_000);
    });

    it('AC-2: a $1,000 RTA inflow raises RTA by exactly $1,000; assigning $1,000 returns it', async () => {
      const before = (await getMonth('2026-06')).rtaMilliunits;
      await addTransaction({
        accountId: chequing.id,
        date: '2026-06-01',
        amount: '1000.00',
        payeeName: 'Employer',
        categoryId: INFLOW_READY_TO_ASSIGN_CATEGORY_ID,
      });
      expect((await getMonth('2026-06')).rtaMilliunits).toBe(before + 1_000_000);

      await putAssigned('2026-06', 'groceries', '600.00');
      await putAssigned('2026-06', 'hydro', '400.00');
      expect((await getMonth('2026-06')).rtaMilliunits).toBe(before);
    });

    it('AC-3: June −$40 overspend → July carryover $0 and July RTA exactly $40 lower; +$40 carries', async () => {
      await addTransaction({
        accountId: chequing.id,
        date: '2026-06-01',
        amount: '1000.00',
        payeeName: 'Employer',
        categoryId: INFLOW_READY_TO_ASSIGN_CATEGORY_ID,
      });
      // dining ends June at +$40; groceries at −$40 (pure overspend).
      await putAssigned('2026-06', 'dining', '40.00');
      const julyBefore = (await getMonth('2026-07')).rtaMilliunits;
      await addTransaction({
        accountId: chequing.id,
        date: '2026-06-20',
        amount: '-40.00',
        payeeName: 'Loblaws',
        categoryId: 'groceries',
      });

      const june = await getMonth('2026-06');
      expect(categoryRow(june, 'groceries').availableMilliunits).toBe(-40_000);

      const july = await getMonth('2026-07');
      expect(categoryRow(july, 'groceries').carryoverMilliunits).toBe(0);
      expect(categoryRow(july, 'groceries').availableMilliunits).toBe(0);
      expect(categoryRow(july, 'dining').carryoverMilliunits).toBe(40_000); // positive carries
      expect(july.rtaMilliunits).toBe(julyBefore - 40_000);
      expect(july.overspendDeductedMilliunits).toBe(40_000);
      // June's own RTA is NOT reduced by June's overspend (it hits July only).
      expect(june.rtaMilliunits).toBe(1_000_000 - 40_000); // inflow − dining assignment
    });

    it('AC-4: tracking-account transactions never appear in activity and never affect RTA (FR-10)', async () => {
      const tfsa = await createAccount('TFSA', 'tracking', '5000.00');
      const before = await getMonth('2026-06');
      await addTransaction({
        accountId: tfsa.id,
        date: '2026-06-05',
        amount: '500.00',
        payeeName: 'Contribution',
      });
      const after = await getMonth('2026-06');
      expect(after).toEqual(before); // not a single budget number moved
    });

    it('AC-5: an assignment in a FUTURE month does not change this month\'s RTA, but counts from that month on', async () => {
      await addTransaction({
        accountId: chequing.id,
        date: '2026-06-01',
        amount: '1000.00',
        payeeName: 'Employer',
        categoryId: INFLOW_READY_TO_ASSIGN_CATEGORY_ID,
      });
      await putAssigned('2026-09', 'groceries', '250.00');
      expect((await getMonth('2026-06')).rtaMilliunits).toBe(1_000_000);
      expect((await getMonth('2026-08')).rtaMilliunits).toBe(1_000_000);
      expect((await getMonth('2026-09')).rtaMilliunits).toBe(750_000);
      expect((await getMonth('2026-10')).rtaMilliunits).toBe(750_000);
    });

    it('split transactions: lines carry the activity, the parent is never counted (E2.S4 contract)', async () => {
      await addTransaction({
        accountId: chequing.id,
        date: '2026-06-08',
        amount: '-90.00',
        payeeName: 'Costco',
        splits: [
          { categoryId: 'groceries', amount: '-60.00' },
          { categoryId: 'dining', amount: '-30.00' },
        ],
      });
      const payload = await getMonth('2026-06');
      expect(categoryRow(payload, 'groceries').activityMilliunits).toBe(-60_000);
      expect(categoryRow(payload, 'dining').activityMilliunits).toBe(-30_000);
      // Total activity across the budget is the split's total, once.
      const totalActivity = payload.groups
        .flatMap((g) => g.categories)
        .reduce((sum, c) => sum + c.activityMilliunits, 0);
      expect(totalActivity).toBe(-90_000);
    });

    it('re-categorizing a past transaction flows through every dependent month', async () => {
      await addTransaction({
        accountId: chequing.id,
        date: '2026-02-01',
        amount: '1000.00',
        payeeName: 'Employer',
        categoryId: INFLOW_READY_TO_ASSIGN_CATEGORY_ID,
      });
      await putAssigned('2026-02', 'groceries', '100.00');
      const created = await addTransaction({
        accountId: chequing.id,
        date: '2026-02-10',
        amount: '-100.00',
        payeeName: 'Mystery',
        categoryId: 'dining', // initially miscategorized: dining overspends −$100
      });
      // dining's Feb overspend deducts $100 from March RTA.
      expect((await getMonth('2026-03')).rtaMilliunits).toBe(1_000_000 - 100_000 - 100_000);

      const patch = await rig.inject({
        method: 'PATCH',
        url: `/api/transactions/${created.transaction.id}`,
        payload: { categoryId: 'groceries' },
      });
      expect(patch.statusCode).toBe(200);

      // Now groceries (funded $100) absorbs it: no overspend, no deduction.
      const feb = await getMonth('2026-02');
      expect(categoryRow(feb, 'dining').activityMilliunits).toBe(0);
      expect(categoryRow(feb, 'groceries').availableMilliunits).toBe(0);
      expect((await getMonth('2026-03')).rtaMilliunits).toBe(1_000_000 - 100_000);
    });

    it('months with zero transactions still render: carryover and RTA flow through', async () => {
      await addTransaction({
        accountId: chequing.id,
        date: '2026-01-05',
        amount: '500.00',
        payeeName: 'Employer',
        categoryId: INFLOW_READY_TO_ASSIGN_CATEGORY_ID,
      });
      await putAssigned('2026-01', 'groceries', '200.00');
      const april = await getMonth('2026-04'); // Feb–Apr have no rows at all
      expect(april.rtaMilliunits).toBe(300_000);
      expect(categoryRow(april, 'groceries').carryoverMilliunits).toBe(200_000);
      expect(categoryRow(april, 'groceries').availableMilliunits).toBe(200_000);
    });

    it('rejects an invalid month with 400', async () => {
      for (const bad of ['2026-13', '2026-6', 'junk']) {
        const res = await rig.inject({ method: 'GET', url: `/api/budget/${bad}` });
        expect(res.statusCode, bad).toBe(400);
      }
    });

    it('is behind the session wall', async () => {
      const res = await rig.app.inject({ method: 'GET', url: '/api/budget/2026-06' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('PUT /api/budget/:month/categories/:categoryId — assignments (for E3.S3)', () => {
    it('upserts, survives reload, and returns the recomputed month payload in the same round trip', async () => {
      const payload = await putAssigned('2026-06', 'groceries', '200.00');
      expect(categoryRow(payload, 'groceries').assignedMilliunits).toBe(200_000);
      expect(payload.rtaMilliunits).toBe(-200_000); // over-assigned: warn, never block (FR-6)

      const reloaded = await getMonth('2026-06');
      expect(categoryRow(reloaded, 'groceries').assignedMilliunits).toBe(200_000);

      // Editing the same cell replaces, not accumulates.
      const edited = await putAssigned('2026-06', 'groceries', '150.00');
      expect(categoryRow(edited, 'groceries').assignedMilliunits).toBe(150_000);
      expect(edited.rtaMilliunits).toBe(-150_000);
    });

    it('negative assignments are allowed (FR-4 adjustments)', async () => {
      const payload = await putAssigned('2026-06', 'groceries', '-25.00');
      expect(categoryRow(payload, 'groceries').assignedMilliunits).toBe(-25_000);
      expect(payload.rtaMilliunits).toBe(25_000);
    });

    it('assigning 0 clears the stored row (no zero-row residue in month bounds)', async () => {
      await putAssigned('2026-06', 'groceries', '200.00');
      await putAssigned('2026-06', 'groceries', '0');
      const rows = rig.db
        .prepare("SELECT * FROM month_assignments WHERE category_id = 'groceries'")
        .all();
      expect(rows).toEqual([]);
      expect(categoryRow(await getMonth('2026-06'), 'groceries').assignedMilliunits).toBe(0);
    });

    it('rejects unknown categories with 404 and the RTA inflow category with 400', async () => {
      const unknown = await rig.inject({
        method: 'PUT',
        url: '/api/budget/2026-06/categories/nope',
        payload: { assigned: '10.00' },
      });
      expect(unknown.statusCode).toBe(404);

      const inflow = await rig.inject({
        method: 'PUT',
        url: `/api/budget/2026-06/categories/${INFLOW_READY_TO_ASSIGN_CATEGORY_ID}`,
        payload: { assigned: '10.00' },
      });
      expect(inflow.statusCode).toBe(400);
    });

    it('rejects bad amounts and bad months with 400; requires the CSRF header', async () => {
      for (const assigned of ['1.005', 'abc', '1,000.00']) {
        const res = await rig.inject({
          method: 'PUT',
          url: '/api/budget/2026-06/categories/groceries',
          payload: { assigned },
        });
        expect(res.statusCode, assigned).toBe(400);
      }
      const badMonth = await rig.inject({
        method: 'PUT',
        url: '/api/budget/2026-13/categories/groceries',
        payload: { assigned: '10.00' },
      });
      expect(badMonth.statusCode).toBe(400);

      const noCsrf = await rig.app.inject({
        method: 'PUT',
        url: '/api/budget/2026-06/categories/groceries',
        headers: { cookie: rig.authed.cookie }, // session yes, CSRF header no
        payload: { assigned: '10.00' },
      });
      expect(noCsrf.statusCode).toBe(403);
      expect(noCsrf.json()).toEqual({ error: 'csrf_header_required' });
    });

    it('a past-month assignment ripples through carryover into the current month (S3 AC-4 groundwork)', async () => {
      await addTransaction({
        accountId: chequing.id,
        date: '2026-03-01',
        amount: '300.00',
        payeeName: 'Employer',
        categoryId: INFLOW_READY_TO_ASSIGN_CATEGORY_ID,
      });
      await putAssigned('2026-03', 'groceries', '120.00');
      const june = await getMonth('2026-06');
      expect(categoryRow(june, 'groceries').carryoverMilliunits).toBe(120_000);
      expect(june.rtaMilliunits).toBe(180_000);
    });
  });
});
