import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AccountResponse,
  AccountsResponse,
  RegisterResponse,
  TransactionMutationResponse,
} from '@ynab-clone/shared';
import { createTestRig, type TestRig } from './helpers.js';

// E2.S1 over HTTP: create / list / close / reopen accounts; on-budget vs
// tracking semantics; derived working+cleared balances (ADR-005).

describe('accounts API (E2.S1)', () => {
  let rig: TestRig;

  beforeEach(async () => {
    rig = await createTestRig();
  });
  afterEach(async () => {
    await rig.cleanup();
  });

  async function createAccount(
    body: Record<string, unknown>,
  ): Promise<{ status: number; account: AccountResponse }> {
    const res = await rig.inject({ method: 'POST', url: '/api/accounts', payload: body });
    return { status: res.statusCode, account: res.json() as AccountResponse };
  }

  it('AC-1: creating an account with name, type, and starting balance shows working balance = starting balance, stored as integer milliunits', async () => {
    const { status, account } = await createAccount({
      name: 'RBC Chequing',
      type: 'chequing',
      startingBalance: '1234.56',
      startingDate: '2026-06-01',
    });
    expect(status).toBe(201);
    expect(account.workingBalanceMilliunits).toBe(1234560);
    expect(account.clearedBalanceMilliunits).toBe(1234560);
    expect(account.onBudget).toBe(true);

    const list = await rig.inject({ method: 'GET', url: '/api/accounts' });
    const accounts = (list.json() as AccountsResponse).accounts;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.workingBalanceMilliunits).toBe(1234560);

    // The starting balance is stored as a real INTEGER-milliunits transaction (NFR-12).
    const row = rig.db
      .prepare('SELECT amount_milliunits, is_starting_balance FROM transactions WHERE account_id = ?')
      .get(account.id);
    expect(row).toEqual({ amount_milliunits: 1234560, is_starting_balance: 1 });
  });

  it('AC-1: rejects a sub-cent starting balance (FR-32)', async () => {
    const { status } = await createAccount({
      name: 'Bad',
      type: 'chequing',
      startingBalance: '10.005',
    });
    expect(status).toBe(400);
  });

  it('AC-3: a $500 inflow to a tracking account changes its balance but touches no category, and categorizing it is rejected (FR-10)', async () => {
    const { account } = await createAccount({
      name: 'TFSA',
      type: 'tracking',
      startingBalance: '50000.00',
      startingDate: '2026-06-01',
    });
    expect(account.onBudget).toBe(false);

    const inflow = await rig.inject({
      method: 'POST',
      url: '/api/transactions',
      payload: { accountId: account.id, date: '2026-06-10', amount: '500.00' },
    });
    expect(inflow.statusCode).toBe(201);
    const mutation = inflow.json() as TransactionMutationResponse;
    expect(mutation.transaction.categoryId).toBeNull();
    expect(mutation.accountBalances[0]!.workingBalanceMilliunits).toBe(50000000 + 500000);

    // No transaction in this account references any category (the budget
    // engine in E3 reads activity from category_id — the seam stays clean).
    const categorized = rig.db
      .prepare('SELECT COUNT(*) AS n FROM transactions WHERE account_id = ? AND category_id IS NOT NULL')
      .get(account.id);
    expect(categorized).toEqual({ n: 0 });

    // Explicitly categorizing a tracking-account transaction is refused.
    const rejected = await rig.inject({
      method: 'POST',
      url: '/api/transactions',
      payload: {
        accountId: account.id,
        date: '2026-06-11',
        amount: '1.00',
        categoryId: 'system-inflow-ready-to-assign',
      },
    });
    expect(rejected.statusCode).toBe(400);
    expect((rejected.json() as { error: string }).error).toBe(
      'category_not_allowed_on_tracking_account',
    );
  });

  it('AC-4: closing an account removes it from the active list, keeps its history visible, and it can be reopened (FR-11)', async () => {
    const { account } = await createAccount({
      name: 'Old Account',
      type: 'chequing',
      startingBalance: '100.00',
      startingDate: '2026-06-01',
    });
    await rig.inject({
      method: 'POST',
      url: '/api/transactions',
      payload: { accountId: account.id, date: '2026-06-05', amount: '-25.00', memo: 'history' },
    });

    const close = await rig.inject({
      method: 'PATCH',
      url: `/api/accounts/${account.id}`,
      payload: { closed: true },
    });
    expect(close.statusCode).toBe(200);
    expect((close.json() as AccountResponse).closed).toBe(true);

    const active = await rig.inject({ method: 'GET', url: '/api/accounts' });
    expect((active.json() as AccountsResponse).accounts).toHaveLength(0);
    const all = await rig.inject({ method: 'GET', url: '/api/accounts?includeClosed=true' });
    expect((all.json() as AccountsResponse).accounts).toHaveLength(1);

    // Transactions remain visible in history.
    const register = await rig.inject({
      method: 'GET',
      url: `/api/accounts/${account.id}/transactions`,
    });
    expect(register.statusCode).toBe(200);
    expect((register.json() as RegisterResponse).transactions).toHaveLength(2);

    const reopen = await rig.inject({
      method: 'PATCH',
      url: `/api/accounts/${account.id}`,
      payload: { closed: false },
    });
    expect((reopen.json() as AccountResponse).closed).toBe(false);
    const activeAgain = await rig.inject({ method: 'GET', url: '/api/accounts' });
    expect((activeAgain.json() as AccountsResponse).accounts).toHaveLength(1);
  });

  it('AC-5: every account exposes both working and cleared balances (FR-12, FR-17)', async () => {
    const { account } = await createAccount({
      name: 'Spending',
      type: 'chequing',
      startingBalance: '100.00', // starting balance is cleared
      startingDate: '2026-06-01',
    });
    // Manual entries are uncleared until E2.S6 — they move working only.
    await rig.inject({
      method: 'POST',
      url: '/api/transactions',
      payload: { accountId: account.id, date: '2026-06-05', amount: '-30.00' },
    });

    const res = await rig.inject({ method: 'GET', url: `/api/accounts/${account.id}` });
    const fetched = res.json() as AccountResponse;
    expect(fetched.workingBalanceMilliunits).toBe(70000);
    expect(fetched.clearedBalanceMilliunits).toBe(100000);
  });

  it('renaming via PATCH works and duplicate names are 409', async () => {
    const { account } = await createAccount({
      name: 'One',
      type: 'chequing',
      startingBalance: '0',
    });
    await createAccount({ name: 'Two', type: 'savings', startingBalance: '0' });

    const renamed = await rig.inject({
      method: 'PATCH',
      url: `/api/accounts/${account.id}`,
      payload: { name: 'Renamed' },
    });
    expect((renamed.json() as AccountResponse).name).toBe('Renamed');

    const dup = await rig.inject({
      method: 'PATCH',
      url: `/api/accounts/${account.id}`,
      payload: { name: 'Two' },
    });
    expect(dup.statusCode).toBe(409);

    const dupCreate = await createAccount({ name: 'two', type: 'chequing', startingBalance: '0' });
    expect(dupCreate.status).toBe(409);
  });

  it('account routes sit behind the session wall (FR-33)', async () => {
    const res = await rig.app.inject({ method: 'GET', url: '/api/accounts' });
    expect(res.statusCode).toBe(401);
  });
});
