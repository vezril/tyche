import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AccountResponse, RegisterResponse } from '@ynab-clone/shared';
import { createTestRig, type TestRig } from './helpers.js';

// E2.S2: the per-account register — list, sort, filter, search, totals,
// windowed reads, and the NFR-1 latest-100-of-10k budget.

describe('register API (E2.S2)', () => {
  let rig: TestRig;
  let account: AccountResponse;
  let groceriesId: string;

  beforeEach(async () => {
    rig = await createTestRig();
    const created = await rig.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        name: 'Spending',
        type: 'chequing',
        startingBalance: '1000.00',
        startingDate: '2026-01-01',
      },
    });
    account = created.json() as AccountResponse;
    // A user category for filter tests (category management is E3.S6; raw
    // insert mirrors what migration/E3 will produce).
    groceriesId = randomUUID();
    rig.db
      .prepare("INSERT INTO category_groups (id, name, sort_order) VALUES ('g1', 'Everyday', 1)")
      .run();
    rig.db
      .prepare("INSERT INTO categories (id, group_id, name, sort_order) VALUES (?, 'g1', 'Groceries', 0)")
      .run(groceriesId);
  });
  afterEach(async () => {
    await rig.cleanup();
  });

  async function addTransaction(body: Record<string, unknown>): Promise<void> {
    const res = await rig.inject({
      method: 'POST',
      url: '/api/transactions',
      payload: { accountId: account.id, ...body },
    });
    expect(res.statusCode).toBe(201);
  }

  async function register(qs = ''): Promise<RegisterResponse> {
    const res = await rig.inject({
      method: 'GET',
      url: `/api/accounts/${account.id}/transactions${qs}`,
    });
    expect(res.statusCode).toBe(200);
    return res.json() as RegisterResponse;
  }

  it('AC-1: rows carry date, payee, category, memo, amount, cleared status, and approval status (FR-13)', async () => {
    await addTransaction({
      date: '2026-02-10',
      amount: '-45.20',
      payeeName: 'Loblaws',
      categoryId: groceriesId,
      memo: 'weekly shop',
    });
    const page = await register();
    expect(page.transactions).toHaveLength(2); // entry + starting balance
    const row = page.transactions[0]!;
    expect(row).toMatchObject({
      date: '2026-02-10',
      payeeName: 'Loblaws',
      categoryName: 'Groceries',
      memo: 'weekly shop',
      amountMilliunits: -45200,
      status: 'uncleared',
      approved: true,
    });
    // Working vs cleared balances ride along with every register read.
    expect(page.workingBalanceMilliunits).toBe(1000000 - 45200);
    expect(page.clearedBalanceMilliunits).toBe(1000000);
  });

  it('AC-2: a payee-substring search returns exactly the matching transactions', async () => {
    await addTransaction({ date: '2026-02-01', amount: '-10.00', payeeName: 'Loblaws' });
    await addTransaction({ date: '2026-02-02', amount: '-20.00', payeeName: 'Shoppers Drug Mart' });
    await addTransaction({ date: '2026-02-03', amount: '-30.00', payeeName: 'Loblaws City Market' });

    const page = await register('?search=obla');
    expect(page.transactions.map((t) => t.payeeName).sort()).toEqual([
      'Loblaws',
      'Loblaws City Market',
    ]);
    expect(page.totalCount).toBe(2);
  });

  it('AC-3: date-range, payee, and category filters combine, and filtered totals match the filter', async () => {
    await addTransaction({
      date: '2026-02-01',
      amount: '-10.00',
      payeeName: 'Loblaws',
      categoryId: groceriesId,
    });
    await addTransaction({
      date: '2026-03-01',
      amount: '-20.00',
      payeeName: 'Loblaws',
      categoryId: groceriesId,
    });
    await addTransaction({ date: '2026-03-05', amount: '-40.00', payeeName: 'Petro-Canada' });

    const byCategory = await register(`?categoryId=${groceriesId}`);
    expect(byCategory.totalCount).toBe(2);
    expect(byCategory.filteredTotalMilliunits).toBe(-30000);

    const payeeId = byCategory.transactions[0]!.payeeId!;
    const combined = await register(
      `?payeeId=${payeeId}&categoryId=${groceriesId}&from=2026-02-15&to=2026-03-31`,
    );
    expect(combined.totalCount).toBe(1);
    expect(combined.transactions[0]!.date).toBe('2026-03-01');
    expect(combined.filteredTotalMilliunits).toBe(-20000);

    const range = await register('?from=2026-03-01&to=2026-03-31');
    expect(range.totalCount).toBe(2);
    expect(range.filteredTotalMilliunits).toBe(-60000);
  });

  it('AC-6: date sort toggles within the current filter', async () => {
    await addTransaction({ date: '2026-02-01', amount: '-1.00', payeeName: 'A' });
    await addTransaction({ date: '2026-02-03', amount: '-2.00', payeeName: 'B' });
    await addTransaction({ date: '2026-02-02', amount: '-3.00', payeeName: 'C' });

    const desc = await register('?from=2026-02-01'); // default: latest first
    expect(desc.transactions.map((t) => t.date)).toEqual([
      '2026-02-03',
      '2026-02-02',
      '2026-02-01',
    ]);
    const asc = await register('?from=2026-02-01&sort=asc');
    expect(asc.transactions.map((t) => t.date)).toEqual([
      '2026-02-01',
      '2026-02-02',
      '2026-02-03',
    ]);
  });

  it('windows with limit/offset while totals still cover the whole filtered set', async () => {
    for (let day = 1; day <= 9; day++) {
      await addTransaction({ date: `2026-02-0${day}`, amount: '-1.00', payeeName: 'D' });
    }
    const page = await register('?limit=4&offset=4&from=2026-02-01');
    expect(page.transactions.map((t) => t.date)).toEqual([
      '2026-02-05',
      '2026-02-04',
      '2026-02-03',
      '2026-02-02',
    ]);
    expect(page.totalCount).toBe(9);
    expect(page.filteredTotalMilliunits).toBe(-9000);
  });

  it('AC-4: the latest-100 view of a 10k-transaction account stays well under the 1 s budget (NFR-1)', async () => {
    // Seed 10k rows directly (the API path would dominate the test's own time).
    const payeeId = randomUUID();
    rig.db.prepare('INSERT INTO payees (id, name) VALUES (?, ?)').run(payeeId, 'Bulk Payee');
    const insert = rig.db.prepare(
      `INSERT INTO transactions (id, account_id, date, amount_milliunits, payee_id, category_id, memo, status, approved, source)
       VALUES (?, ?, ?, ?, ?, ?, '', 'cleared', 1, 'migration')`,
    );
    const seed = rig.db.transaction(() => {
      for (let i = 0; i < 10000; i++) {
        const day = (i % 28) + 1;
        const month = (i % 12) + 1;
        const year = 2021 + (i % 5);
        const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        insert.run(randomUUID(), account.id, date, -(i + 1) * 10, payeeId, groceriesId);
      }
    });
    seed();

    const durations: number[] = [];
    let page: RegisterResponse | undefined;
    for (let run = 0; run < 20; run++) {
      const start = performance.now();
      page = await register('?limit=100');
      durations.push(performance.now() - start);
    }
    expect(page!.transactions).toHaveLength(100);
    expect(page!.totalCount).toBe(10001); // + starting balance
    durations.sort((a, b) => a - b);
    const p95 = durations[18]!;
    // Server-side budget: the full 1 s is for render over LAN; the API read
    // must be a small fraction of it.
    expect(p95).toBeLessThan(250);
  });

  it('register of an unknown account is 404', async () => {
    const res = await rig.inject({ method: 'GET', url: '/api/accounts/nope/transactions' });
    expect(res.statusCode).toBe(404);
  });
});
