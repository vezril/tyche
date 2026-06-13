import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AccountResponse,
  BudgetMonthResponse,
  CategoriesResponse,
  CategoryStructureResponse,
  PayeesResponse,
  RegisterResponse,
} from '@ynab-clone/shared';
import {
  INFLOW_READY_TO_ASSIGN_CATEGORY_ID,
  RECONCILIATION_ADJUSTMENT_CATEGORY_ID,
  SYSTEM_CATEGORY_GROUP_ID,
} from '../../src/db/seed.js';
import { createTestRig, type TestRig } from './helpers.js';

// E3.S6 over HTTP (FR-9): create/rename/reorder/hide/delete for categories and
// groups. Deleting a category WITH history requires a reassignment target —
// transactions (split lines included) move to the target and month_assignments
// merge into it per month (sum when both exist), all in one DB transaction.
// The two seeded system categories are protected: rename/hide/delete → 403.

describe('category management API (E3.S6)', () => {
  let rig: TestRig;
  let chequing: AccountResponse;

  async function structure(): Promise<CategoryStructureResponse> {
    const res = await rig.inject({ method: 'GET', url: '/api/categories/structure' });
    expect(res.statusCode).toBe(200);
    return res.json() as CategoryStructureResponse;
  }

  async function pickerCategories(): Promise<string[]> {
    const res = await rig.inject({ method: 'GET', url: '/api/categories' });
    expect(res.statusCode).toBe(200);
    return (res.json() as CategoriesResponse).categories.map((c) => c.id);
  }

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

  async function addTransaction(payload: Record<string, unknown>): Promise<string> {
    const res = await rig.inject({ method: 'POST', url: '/api/transactions', payload });
    expect(res.statusCode).toBe(201);
    return (res.json() as { transaction: { id: string } }).transaction.id;
  }

  const groupNames = (s: CategoryStructureResponse): string[] => s.groups.map((g) => g.name);
  const categoryIdsOf = (s: CategoryStructureResponse, groupName: string): string[] =>
    s.groups.find((g) => g.name === groupName)!.categories.map((c) => c.id);

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
    rig.db
      .prepare("INSERT INTO category_groups (id, name, sort_order) VALUES ('g2', 'Bills', 2)")
      .run();
    const cat = rig.db.prepare(
      'INSERT INTO categories (id, group_id, name, sort_order, hidden) VALUES (?, ?, ?, ?, 0)',
    );
    cat.run('groceries', 'g1', 'Groceries', 1);
    cat.run('dining', 'g1', 'Dining', 2);
    cat.run('hydro', 'g2', 'Hydro', 1);
  });
  afterEach(async () => {
    await rig.cleanup();
  });

  describe('structure view + create/rename (AC-1)', () => {
    it('GET /api/categories/structure lists ordered groups with hidden flags, system group excluded', async () => {
      rig.db.prepare("UPDATE categories SET hidden = 1 WHERE id = 'dining'").run();
      const s = await structure();
      expect(groupNames(s)).toEqual(['Everyday', 'Bills']);
      expect(s.groups[0]!.categories).toEqual([
        { id: 'groceries', name: 'Groceries', hidden: false },
        { id: 'dining', name: 'Dining', hidden: true }, // hidden rows stay manageable
      ]);
      expect(groupNames(s)).not.toContain('System');
    });

    it('created groups and categories appear in the structure, the picker, and the grid immediately', async () => {
      const created = await rig.inject({
        method: 'POST',
        url: '/api/category-groups',
        payload: { name: 'Savings Goals' },
      });
      expect(created.statusCode).toBe(201);
      const groupId = (created.json() as CategoryStructureResponse).groups.find(
        (g) => g.name === 'Savings Goals',
      )!.id;

      const newCat = await rig.inject({
        method: 'POST',
        url: '/api/categories',
        payload: { groupId, name: 'Vacation' },
      });
      expect(newCat.statusCode).toBe(201);

      expect(groupNames(await structure())).toEqual(['Everyday', 'Bills', 'Savings Goals']);
      const picker = await rig.inject({ method: 'GET', url: '/api/categories' });
      expect(
        (picker.json() as CategoriesResponse).categories.some((c) => c.name === 'Vacation'),
      ).toBe(true);
      const month = await getMonth('2026-06');
      expect(month.groups.map((g) => g.name)).toContain('Savings Goals');
      expect(month.groups.flatMap((g) => g.categories.map((c) => c.name))).toContain('Vacation');
    });

    it('renames groups and categories', async () => {
      const g = await rig.inject({
        method: 'PATCH',
        url: '/api/category-groups/g1',
        payload: { name: 'Day to Day' },
      });
      expect(g.statusCode).toBe(200);
      const c = await rig.inject({
        method: 'PATCH',
        url: '/api/categories/groceries',
        payload: { name: 'Food' },
      });
      expect(c.statusCode).toBe(200);
      const s = await structure();
      expect(groupNames(s)).toContain('Day to Day');
      expect(s.groups[0]!.categories[0]!.name).toBe('Food');
    });

    it('rejects blank and colliding names (case-insensitive), including the reserved system names', async () => {
      const blank = await rig.inject({
        method: 'POST',
        url: '/api/category-groups',
        payload: { name: '   ' },
      });
      expect(blank.statusCode).toBe(400);

      const dupGroup = await rig.inject({
        method: 'POST',
        url: '/api/category-groups',
        payload: { name: 'everyday' },
      });
      expect(dupGroup.statusCode).toBe(409);

      const dupCat = await rig.inject({
        method: 'PATCH',
        url: '/api/categories/dining',
        payload: { name: 'GROCERIES' },
      });
      expect(dupCat.statusCode).toBe(409);

      // AC-6: nothing may be renamed INTO collision with a system category.
      const reserved = await rig.inject({
        method: 'PATCH',
        url: '/api/categories/dining',
        payload: { name: 'Inflow: Ready to Assign' },
      });
      expect(reserved.statusCode).toBe(409);
    });
  });

  describe('reordering (AC-2)', () => {
    it('reorders categories within a group and persists', async () => {
      const res = await rig.inject({
        method: 'PATCH',
        url: '/api/categories/dining',
        payload: { index: 0 },
      });
      expect(res.statusCode).toBe(200);
      expect(categoryIdsOf(await structure(), 'Everyday')).toEqual(['dining', 'groceries']);
      const month = await getMonth('2026-06');
      expect(month.groups[0]!.categories.map((c) => c.categoryId)).toEqual([
        'dining',
        'groceries',
      ]);
    });

    it('moves a category across groups at a chosen position', async () => {
      const res = await rig.inject({
        method: 'PATCH',
        url: '/api/categories/groceries',
        payload: { groupId: 'g2', index: 0 },
      });
      expect(res.statusCode).toBe(200);
      const s = await structure();
      expect(categoryIdsOf(s, 'Everyday')).toEqual(['dining']);
      expect(categoryIdsOf(s, 'Bills')).toEqual(['groceries', 'hydro']);
    });

    it('reorders groups themselves and the grid renders the new order', async () => {
      const res = await rig.inject({
        method: 'PATCH',
        url: '/api/category-groups/g2',
        payload: { index: 0 },
      });
      expect(res.statusCode).toBe(200);
      expect(groupNames(await structure())).toEqual(['Bills', 'Everyday']);
      expect((await getMonth('2026-06')).groups.map((g) => g.name)).toEqual([
        'Bills',
        'Everyday',
      ]);
    });
  });

  describe('hide/unhide (AC-3)', () => {
    it('a hidden category leaves the grid and picker but its history stays in all math; unhide restores it', async () => {
      await addTransaction({
        accountId: chequing.id,
        date: '2026-06-01',
        amount: '1000.00',
        payeeName: 'Employer',
        categoryId: INFLOW_READY_TO_ASSIGN_CATEGORY_ID,
      });
      await putAssigned('2026-06', 'dining', '100.00');
      await addTransaction({
        accountId: chequing.id,
        date: '2026-06-10',
        amount: '-40.00',
        payeeName: 'Pizza',
        categoryId: 'dining',
      });
      const before = await getMonth('2026-06');

      const res = await rig.inject({
        method: 'PATCH',
        url: '/api/categories/dining',
        payload: { hidden: true },
      });
      expect(res.statusCode).toBe(200);

      expect(await pickerCategories()).not.toContain('dining');
      const hiddenMonth = await getMonth('2026-06');
      expect(hiddenMonth.groups.flatMap((g) => g.categories.map((c) => c.categoryId))).not.toContain(
        'dining',
      );
      // History remains in ALL math: RTA and the assigned total are unchanged.
      expect(hiddenMonth.rtaMilliunits).toBe(before.rtaMilliunits);
      expect(hiddenMonth.assignedThisMonthMilliunits).toBe(before.assignedThisMonthMilliunits);

      const unhide = await rig.inject({
        method: 'PATCH',
        url: '/api/categories/dining',
        payload: { hidden: false },
      });
      expect(unhide.statusCode).toBe(200);
      expect(await pickerCategories()).toContain('dining');
    });

    it('hiding a group hides it from the grid while its members stay in the math', async () => {
      await putAssigned('2026-06', 'hydro', '50.00');
      const before = await getMonth('2026-06');
      const res = await rig.inject({
        method: 'PATCH',
        url: '/api/category-groups/g2',
        payload: { hidden: true },
      });
      expect(res.statusCode).toBe(200);
      const month = await getMonth('2026-06');
      expect(month.groups.map((g) => g.name)).toEqual(['Everyday']);
      expect(month.rtaMilliunits).toBe(before.rtaMilliunits);
      expect(month.assignedThisMonthMilliunits).toBe(before.assignedThisMonthMilliunits);
    });
  });

  describe('delete (AC-4, AC-5)', () => {
    it('AC-5: a category with no history deletes without a reassignment target', async () => {
      const res = await rig.inject({ method: 'DELETE', url: '/api/categories/dining' });
      expect(res.statusCode).toBe(200);
      expect(categoryIdsOf(await structure(), 'Everyday')).toEqual(['groceries']);
      expect(await pickerCategories()).not.toContain('dining');
    });

    it('AC-4: with transaction history, delete requires a target; afterwards transactions and balances report the target', async () => {
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
        amount: '-40.00',
        payeeName: 'Pizza',
        categoryId: 'dining',
      });

      const refused = await rig.inject({ method: 'DELETE', url: '/api/categories/dining' });
      expect(refused.statusCode).toBe(409);
      expect((refused.json() as { error: string }).error).toBe('reassignment_required');

      const ok = await rig.inject({
        method: 'DELETE',
        url: '/api/categories/dining?reassignTo=groceries',
      });
      expect(ok.statusCode).toBe(200);

      // All its transactions now report the target category…
      const register = await rig.inject({
        method: 'GET',
        url: `/api/accounts/${chequing.id}/transactions`,
      });
      const rows = (register.json() as RegisterResponse).transactions;
      expect(rows.some((t) => t.categoryId === 'dining')).toBe(false);
      expect(rows.find((t) => t.payeeName === 'Pizza')!.categoryId).toBe('groceries');
      expect(rows.find((t) => t.payeeName === 'Pizza')!.categoryName).toBe('Groceries');

      // …the source is gone, and recomputed balances reflect the reassignment.
      const month = await getMonth('2026-06');
      const ids = month.groups.flatMap((g) => g.categories.map((c) => c.categoryId));
      expect(ids).not.toContain('dining');
      const groceries = month.groups
        .flatMap((g) => g.categories)
        .find((c) => c.categoryId === 'groceries')!;
      expect(groceries.activityMilliunits).toBe(-40_000);
    });

    it('AC-4: split lines are reassigned too', async () => {
      await addTransaction({
        accountId: chequing.id,
        date: '2026-06-08',
        amount: '-90.00',
        payeeName: 'Costco',
        splits: [
          { categoryId: 'dining', amount: '-60.00' },
          { categoryId: 'groceries', amount: '-30.00' },
        ],
      });
      const res = await rig.inject({
        method: 'DELETE',
        url: '/api/categories/dining?reassignTo=groceries',
      });
      expect(res.statusCode).toBe(200);
      const groceries = (await getMonth('2026-06')).groups
        .flatMap((g) => g.categories)
        .find((c) => c.categoryId === 'groceries')!;
      expect(groceries.activityMilliunits).toBe(-90_000);
    });

    it('AC-4: month assignments merge into the target per month (sum when both exist)', async () => {
      await putAssigned('2026-05', 'dining', '80.00');
      await putAssigned('2026-06', 'dining', '100.00');
      await putAssigned('2026-06', 'groceries', '50.00');
      const rtaBefore = (await getMonth('2026-06')).rtaMilliunits;

      const res = await rig.inject({
        method: 'DELETE',
        url: '/api/categories/dining?reassignTo=groceries',
      });
      expect(res.statusCode).toBe(200);

      const may = (await getMonth('2026-05')).groups
        .flatMap((g) => g.categories)
        .find((c) => c.categoryId === 'groceries')!;
      expect(may.assignedMilliunits).toBe(80_000); // moved month with no prior row
      const june = (await getMonth('2026-06')).groups
        .flatMap((g) => g.categories)
        .find((c) => c.categoryId === 'groceries')!;
      expect(june.assignedMilliunits).toBe(150_000); // summed where both existed
      expect((await getMonth('2026-06')).rtaMilliunits).toBe(rtaBefore); // totals preserved
      // No orphaned source rows left behind.
      expect(
        rig.db.prepare("SELECT * FROM month_assignments WHERE category_id = 'dining'").all(),
      ).toEqual([]);
    });

    it('assignment-only history still demands a target (assignments are budget history)', async () => {
      await putAssigned('2026-06', 'dining', '25.00');
      const refused = await rig.inject({ method: 'DELETE', url: '/api/categories/dining' });
      expect(refused.statusCode).toBe(409);
    });

    it('rejects invalid reassignment targets: itself, the inflow category, unknowns', async () => {
      await putAssigned('2026-06', 'dining', '25.00');
      for (const target of ['dining', INFLOW_READY_TO_ASSIGN_CATEGORY_ID, 'no-such']) {
        const res = await rig.inject({
          method: 'DELETE',
          url: `/api/categories/dining?reassignTo=${target}`,
        });
        expect(res.statusCode, target).toBe(400);
      }
    });

    it('payee last-category suggestions follow the reassignment (FK stays valid)', async () => {
      await addTransaction({
        accountId: chequing.id,
        date: '2026-06-10',
        amount: '-40.00',
        payeeName: 'Pizza',
        categoryId: 'dining',
      });
      await rig.inject({ method: 'DELETE', url: '/api/categories/dining?reassignTo=groceries' });
      const payees = await rig.inject({ method: 'GET', url: '/api/payees' });
      const pizza = (payees.json() as PayeesResponse).payees.find((p) => p.name === 'Pizza')!;
      expect(pizza.lastCategoryId).toBe('groceries');
    });

    it('group delete requires the group to be empty', async () => {
      const refused = await rig.inject({ method: 'DELETE', url: '/api/category-groups/g1' });
      expect(refused.statusCode).toBe(400);
      expect((refused.json() as { error: string }).error).toBe('group_not_empty');

      await rig.inject({ method: 'DELETE', url: '/api/categories/groceries' });
      await rig.inject({ method: 'DELETE', url: '/api/categories/dining' });
      const ok = await rig.inject({ method: 'DELETE', url: '/api/category-groups/g1' });
      expect(ok.statusCode).toBe(200);
      expect(groupNames(await structure())).toEqual(['Bills']);
    });
  });

  describe('system category protection (AC-6)', () => {
    it('system categories cannot be renamed, hidden, or deleted (403)', async () => {
      for (const id of [INFLOW_READY_TO_ASSIGN_CATEGORY_ID, RECONCILIATION_ADJUSTMENT_CATEGORY_ID]) {
        const rename = await rig.inject({
          method: 'PATCH',
          url: `/api/categories/${id}`,
          payload: { name: 'Sneaky' },
        });
        expect(rename.statusCode, `rename ${id}`).toBe(403);
        const hide = await rig.inject({
          method: 'PATCH',
          url: `/api/categories/${id}`,
          payload: { hidden: true },
        });
        expect(hide.statusCode, `hide ${id}`).toBe(403);
        const del = await rig.inject({
          method: 'DELETE',
          url: `/api/categories/${id}?reassignTo=groceries`,
        });
        expect(del.statusCode, `delete ${id}`).toBe(403);
      }
    });

    it('the system group is equally protected, and nothing can move into it', async () => {
      for (const payload of [{ name: 'Sneaky' }, { hidden: false }, { index: 1 }]) {
        const res = await rig.inject({
          method: 'PATCH',
          url: `/api/category-groups/${SYSTEM_CATEGORY_GROUP_ID}`,
          payload,
        });
        expect(res.statusCode).toBe(403);
      }
      const del = await rig.inject({
        method: 'DELETE',
        url: `/api/category-groups/${SYSTEM_CATEGORY_GROUP_ID}`,
      });
      expect(del.statusCode).toBe(403);

      const create = await rig.inject({
        method: 'POST',
        url: '/api/categories',
        payload: { groupId: SYSTEM_CATEGORY_GROUP_ID, name: 'Intruder' },
      });
      expect(create.statusCode).toBe(403);

      const move = await rig.inject({
        method: 'PATCH',
        url: '/api/categories/dining',
        payload: { groupId: SYSTEM_CATEGORY_GROUP_ID },
      });
      expect(move.statusCode).toBe(403);
    });
  });

  it('every management route sits behind the session wall and CSRF check', async () => {
    const unauthed = await rig.app.inject({ method: 'GET', url: '/api/categories/structure' });
    expect(unauthed.statusCode).toBe(401);
    const noCsrf = await rig.app.inject({
      method: 'POST',
      url: '/api/category-groups',
      headers: { cookie: rig.authed.cookie },
      payload: { name: 'X' },
    });
    expect(noCsrf.statusCode).toBe(403);
  });
});
