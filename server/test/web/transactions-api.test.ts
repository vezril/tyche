import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type {
  AccountResponse,
  DeleteTransactionResponse,
  PayeesResponse,
  RegisterResponse,
  TransactionMutationResponse,
} from '@tyche/shared';
import { createTestRig, type TestRig } from './helpers.js';

// E2.S3 over HTTP: manual entry, editing, deletion; dollars-string parsing at
// the API boundary (ADR-004); payee autocomplete + last-category suggestion;
// recomputed balances returned by every mutation (ADR-005, ADR-008).

describe('transactions API (E2.S3)', () => {
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
        startingBalance: '500.00',
        startingDate: '2026-01-01',
      },
    });
    account = created.json() as AccountResponse;
    groceriesId = randomUUID();
    rig.db.prepare("INSERT INTO category_groups (id, name) VALUES ('g1', 'Everyday')").run();
    rig.db
      .prepare("INSERT INTO categories (id, group_id, name) VALUES (?, 'g1', 'Groceries')")
      .run(groceriesId);
  });
  afterEach(async () => {
    await rig.cleanup();
  });

  it('AC-1: an entered transaction appears in the register, adjusts the account balance, and is categorized for the budget engine (FR-14)', async () => {
    const res = await rig.inject({
      method: 'POST',
      url: '/api/transactions',
      payload: {
        accountId: account.id,
        date: '2026-06-10',
        amount: '-45.20',
        payeeName: 'Loblaws',
        categoryId: groceriesId,
        memo: 'weekly shop',
      },
    });
    expect(res.statusCode).toBe(201);
    const { transaction, accountBalances } = res.json() as TransactionMutationResponse;
    expect(transaction).toMatchObject({
      amountMilliunits: -45200,
      payeeName: 'Loblaws',
      categoryId: groceriesId,
      approved: true, // manual entries are approved (FR-22 is for imports)
      source: 'manual',
      status: 'uncleared',
    });
    // The mutation returns the recomputed balance in the same round trip.
    expect(accountBalances).toEqual([
      {
        accountId: account.id,
        workingBalanceMilliunits: 500000 - 45200,
        clearedBalanceMilliunits: 500000,
      },
    ]);
    // E3's budget math reads activity from this row's category_id; the
    // categorization is persisted exactly (the RTA/category effects land in E3).
    const register = await rig.inject({
      method: 'GET',
      url: `/api/accounts/${account.id}/transactions`,
    });
    expect(
      (register.json() as RegisterResponse).transactions.find((t) => t.id === transaction.id)!
        .categoryName,
    ).toBe('Groceries');
  });

  it('AC-2: a future-dated entry persists and is displayed with its own date (FR-14)', async () => {
    const res = await rig.inject({
      method: 'POST',
      url: '/api/transactions',
      payload: { accountId: account.id, date: '2027-12-31', amount: '-10.00' },
    });
    expect(res.statusCode).toBe(201);
    const register = await rig.inject({
      method: 'GET',
      url: `/api/accounts/${account.id}/transactions`,
    });
    const page = register.json() as RegisterResponse;
    expect(page.transactions[0]!.date).toBe('2027-12-31'); // sorts to the top, latest-first
    expect(page.workingBalanceMilliunits).toBe(500000 - 10000);
  });

  it('AC-3: edits and deletes are reflected in derived balances immediately — recompute-on-read (NFR-12)', async () => {
    const created = await rig.inject({
      method: 'POST',
      url: '/api/transactions',
      payload: { accountId: account.id, date: '2026-06-10', amount: '-100.00' },
    });
    const txId = (created.json() as TransactionMutationResponse).transaction.id;

    const edited = await rig.inject({
      method: 'PATCH',
      url: `/api/transactions/${txId}`,
      payload: { amount: '-60.00', memo: 'corrected' },
    });
    expect(edited.statusCode).toBe(200);
    const editedBody = edited.json() as TransactionMutationResponse;
    expect(editedBody.transaction.amountMilliunits).toBe(-60000);
    expect(editedBody.accountBalances[0]!.workingBalanceMilliunits).toBe(500000 - 60000);

    const deleted = await rig.inject({ method: 'DELETE', url: `/api/transactions/${txId}` });
    expect(deleted.statusCode).toBe(200);
    expect(
      (deleted.json() as DeleteTransactionResponse).accountBalances[0]!.workingBalanceMilliunits,
    ).toBe(500000);

    const refetched = await rig.inject({
      method: 'GET',
      url: `/api/accounts/${account.id}`,
    });
    expect((refetched.json() as AccountResponse).workingBalanceMilliunits).toBe(500000);
  });

  it('AC-4: a payee typed once is offered by substring autocomplete (FR-19)', async () => {
    await rig.inject({
      method: 'POST',
      url: '/api/transactions',
      payload: { accountId: account.id, date: '2026-06-10', amount: '-5.00', payeeName: 'Loblaws' },
    });
    const res = await rig.inject({ method: 'GET', url: '/api/payees?q=obla' });
    const { payees } = res.json() as PayeesResponse;
    expect(payees.map((p) => p.name)).toEqual(['Loblaws']);
  });

  it('AC-5: the payee remembers its last category as the default suggestion (FR-19)', async () => {
    await rig.inject({
      method: 'POST',
      url: '/api/transactions',
      payload: {
        accountId: account.id,
        date: '2026-06-10',
        amount: '-45.20',
        payeeName: 'Loblaws',
        categoryId: groceriesId,
      },
    });
    const res = await rig.inject({ method: 'GET', url: '/api/payees?q=Loblaws' });
    const { payees } = res.json() as PayeesResponse;
    expect(payees[0]!.lastCategoryId).toBe(groceriesId);
    expect(payees[0]!.lastCategoryName).toBe('Groceries');
  });

  it('AC-7: whole cents are enforced — sub-cent and garbage amounts are rejected, valid ones stored as integer milliunits (FR-32)', async () => {
    for (const amount of ['10.005', 'abc', '1,000.00', '']) {
      const res = await rig.inject({
        method: 'POST',
        url: '/api/transactions',
        payload: { accountId: account.id, date: '2026-06-10', amount },
      });
      expect(res.statusCode, `amount "${amount}" must be rejected`).toBe(400);
    }
    const ok = await rig.inject({
      method: 'POST',
      url: '/api/transactions',
      payload: { accountId: account.id, date: '2026-06-10', amount: '-0.01' },
    });
    expect((ok.json() as TransactionMutationResponse).transaction.amountMilliunits).toBe(-10);
  });

  it('rejects invalid calendar dates and unknown accounts/categories', async () => {
    const badDate = await rig.inject({
      method: 'POST',
      url: '/api/transactions',
      payload: { accountId: account.id, date: '2026-02-30', amount: '-1.00' },
    });
    expect(badDate.statusCode).toBe(400);

    const badAccount = await rig.inject({
      method: 'POST',
      url: '/api/transactions',
      payload: { accountId: 'nope', date: '2026-06-10', amount: '-1.00' },
    });
    expect(badAccount.statusCode).toBe(404);

    const badCategory = await rig.inject({
      method: 'POST',
      url: '/api/transactions',
      payload: { accountId: account.id, date: '2026-06-10', amount: '-1.00', categoryId: 'nope' },
    });
    expect(badCategory.statusCode).toBe(404);
  });

  it('editing can recategorize, change payee, and uncategorize', async () => {
    const created = await rig.inject({
      method: 'POST',
      url: '/api/transactions',
      payload: {
        accountId: account.id,
        date: '2026-06-10',
        amount: '-10.00',
        payeeName: 'Loblaws',
        categoryId: groceriesId,
      },
    });
    const txId = (created.json() as TransactionMutationResponse).transaction.id;

    const recategorized = await rig.inject({
      method: 'PATCH',
      url: `/api/transactions/${txId}`,
      payload: { payeeName: 'No Frills', categoryId: null },
    });
    const body = recategorized.json() as TransactionMutationResponse;
    expect(body.transaction.payeeName).toBe('No Frills');
    expect(body.transaction.categoryId).toBeNull();
  });

  it('mutations require the CSRF header (ADR-008)', async () => {
    const res = await rig.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: { cookie: rig.authed.cookie }, // session but no CSRF header
      payload: { accountId: account.id, date: '2026-06-10', amount: '-1.00' },
    });
    expect(res.statusCode).toBe(403);
  });
});
