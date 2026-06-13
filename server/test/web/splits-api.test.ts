import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AccountResponse,
  RegisterResponse,
  TransactionMutationResponse,
} from '@tyche/shared';
import { createTestRig, type TestRig } from './helpers.js';

// E2.S4 over HTTP: split entry/edit with dollars-string lines parsed at the
// boundary (ADR-004), the FR-15 sum constraint with a named discrepancy, and
// register/balance behavior (one row, counted once).

describe('splits API (E2.S4)', () => {
  let rig: TestRig;
  let account: AccountResponse;

  beforeEach(async () => {
    rig = await createTestRig();
    const created = await rig.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        name: 'Spending',
        type: 'chequing',
        startingBalance: '500.00',
        startingDate: '2026-01-01',
      },
    });
    account = created.json() as AccountResponse;
    rig.db.prepare("INSERT INTO category_groups (id, name) VALUES ('g1', 'Everyday')").run();
    const insert = rig.db.prepare(
      "INSERT INTO categories (id, group_id, name) VALUES (?, 'g1', ?)",
    );
    insert.run('cat-groceries', 'Groceries');
    insert.run('cat-household', 'Household');
  });
  afterEach(async () => {
    await rig.cleanup();
  });

  const splitPayload = {
    accountId: '',
    date: '2026-06-10',
    amount: '-130.00',
    payeeName: 'Costco',
    splits: [
      { categoryId: 'cat-groceries', amount: '-80.00', memo: 'food' },
      { categoryId: 'cat-household', amount: '-50.00' },
    ],
  };

  it('AC-1/AC-3: a valid split saves, shows as ONE register row with lines, and the balance counts it once (FR-15)', async () => {
    const res = await rig.inject({
      method: 'POST',
      url: '/api/transactions',
      payload: { ...splitPayload, accountId: account.id },
    });
    expect(res.statusCode).toBe(201);
    const { transaction, accountBalances } = res.json() as TransactionMutationResponse;
    expect(transaction.amountMilliunits).toBe(-130000);
    expect(transaction.categoryId).toBeNull();
    expect(transaction.lines).toEqual([
      expect.objectContaining({
        categoryId: 'cat-groceries',
        categoryName: 'Groceries',
        amountMilliunits: -80000,
        memo: 'food',
      }),
      expect.objectContaining({ categoryId: 'cat-household', amountMilliunits: -50000 }),
    ]);
    expect(accountBalances[0]?.workingBalanceMilliunits).toBe(500000 - 130000);

    const register = (
      await rig.inject({ method: 'GET', url: `/api/accounts/${account.id}/transactions` })
    ).json() as RegisterResponse;
    expect(register.totalCount).toBe(2); // starting balance + ONE split row
    expect(register.transactions.find((t) => t.payeeName === 'Costco')?.lines).toHaveLength(2);
    expect(register.workingBalanceMilliunits).toBe(500000 - 130000);
  });

  it('AC-2: lines that do not sum to the total are rejected with the discrepancy named (FR-15 verified-by)', async () => {
    const res = await rig.inject({
      method: 'POST',
      url: '/api/transactions',
      payload: {
        ...splitPayload,
        accountId: account.id,
        splits: [
          { categoryId: 'cat-groceries', amount: '-80.00' },
          { categoryId: 'cat-household', amount: '-45.00' },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'split_sum_mismatch', discrepancyMilliunits: 5000 });
  });

  it('AC-4: editing lines re-enforces the sum; un-splitting works', async () => {
    const created = (
      await rig.inject({
        method: 'POST',
        url: '/api/transactions',
        payload: { ...splitPayload, accountId: account.id },
      })
    ).json() as TransactionMutationResponse;
    const id = created.transaction.id;

    // amount change without lines breaks the invariant → 400
    const bad = await rig.inject({
      method: 'PATCH',
      url: `/api/transactions/${id}`,
      payload: { amount: '-150.00' },
    });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { error: string }).error).toBe('split_sum_mismatch');

    // amount + matching lines is fine
    const good = await rig.inject({
      method: 'PATCH',
      url: `/api/transactions/${id}`,
      payload: {
        amount: '-150.00',
        splits: [
          { categoryId: 'cat-groceries', amount: '-100.00' },
          { categoryId: 'cat-household', amount: '-50.00' },
        ],
      },
    });
    expect(good.statusCode).toBe(200);
    const updated = good.json() as TransactionMutationResponse;
    expect(updated.transaction.lines.map((l) => l.amountMilliunits)).toEqual([-100000, -50000]);
    expect(updated.accountBalances[0]?.workingBalanceMilliunits).toBe(500000 - 150000);

    // un-split: lines removed, direct category allowed again
    const unsplit = await rig.inject({
      method: 'PATCH',
      url: `/api/transactions/${id}`,
      payload: { splits: null, categoryId: 'cat-groceries' },
    });
    expect(unsplit.statusCode).toBe(200);
    const flat = (unsplit.json() as TransactionMutationResponse).transaction;
    expect(flat.lines).toEqual([]);
    expect(flat.categoryId).toBe('cat-groceries');
  });

  it('rejects splits on tracking accounts and split+transfer combinations', async () => {
    const tracking = (
      await rig.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'TFSA', type: 'tracking', startingBalance: '0.00' },
      })
    ).json() as AccountResponse;

    const onTracking = await rig.inject({
      method: 'POST',
      url: '/api/transactions',
      payload: { ...splitPayload, accountId: tracking.id, payeeName: 'X' },
    });
    expect(onTracking.statusCode).toBe(400);
    expect((onTracking.json() as { error: string }).error).toBe(
      'split_not_allowed_on_tracking_account',
    );

    // split transfers are not required by any FR — explicitly rejected (S4 out-of-scope)
    const splitTransfer = await rig.inject({
      method: 'POST',
      url: '/api/transactions',
      payload: {
        ...splitPayload,
        payeeName: undefined,
        accountId: account.id,
        transferAccountId: tracking.id,
      },
    });
    expect(splitTransfer.statusCode).toBe(400);
    expect((splitTransfer.json() as { error: string }).error).toBe('split_transfer_not_supported');
  });
});
