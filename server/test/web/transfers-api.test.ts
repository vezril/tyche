import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AccountResponse,
  DeleteTransactionResponse,
  PayeesResponse,
  RegisterResponse,
  TransactionMutationResponse,
} from '@ynab-clone/shared';
import { createTestRig, type TestRig } from './helpers.js';

// E2.S5 over HTTP: transfers as two rows sharing a transfer_id (FR-16) —
// paired creation, bidirectional cascade on edit/delete (atomic), category
// rules per the PRD glossary, the "Transfer: <account>" pseudo-payee, and
// per-side cleared status (FR-17).

describe('transfers API (E2.S5)', () => {
  let rig: TestRig;
  let spending: AccountResponse;
  let savings: AccountResponse;
  let tfsa: AccountResponse;
  let vacationId: string;

  const createAccount = async (
    name: string,
    type: string,
    startingBalance: string,
  ): Promise<AccountResponse> =>
    (
      await rig.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name, type, startingBalance, startingDate: '2026-01-01' },
      })
    ).json() as AccountResponse;

  beforeEach(async () => {
    rig = await createTestRig();
    spending = await createAccount('Spending', 'chequing', '1000.00');
    savings = await createAccount('Savings', 'savings', '5000.00');
    tfsa = await createAccount('TFSA', 'tracking', '0.00');
    vacationId = 'cat-vacation';
    rig.db.prepare("INSERT INTO category_groups (id, name) VALUES ('g1', 'Goals')").run();
    rig.db
      .prepare("INSERT INTO categories (id, group_id, name) VALUES (?, 'g1', 'Vacation')")
      .run(vacationId);
  });
  afterEach(async () => {
    await rig.cleanup();
  });

  const transfer = (
    payload: Record<string, unknown>,
  ): Promise<ReturnType<TestRig['inject']>> =>
    rig.inject({
      method: 'POST',
      url: '/api/transactions',
      payload: { date: '2026-06-10', ...payload },
    }) as Promise<ReturnType<TestRig['inject']>>;

  it('AC-1: a $200 on-budget↔on-budget transfer moves both balances, needs no category (FR-16 verified-by)', async () => {
    const res = await transfer({
      accountId: spending.id,
      transferAccountId: savings.id,
      amount: '-200.00',
    });
    expect(res.statusCode).toBe(201);
    const { transaction, accountBalances } = res.json() as TransactionMutationResponse;
    expect(transaction.categoryId).toBeNull();
    expect(transaction.transferAccountId).toBe(savings.id);

    // both balances in one round trip (ADR-005/008)
    const byAccount = new Map(accountBalances.map((b) => [b.accountId, b]));
    expect(byAccount.get(spending.id)?.workingBalanceMilliunits).toBe(1000000 - 200000);
    expect(byAccount.get(savings.id)?.workingBalanceMilliunits).toBe(5000000 + 200000);

    // the paired row exists in the other register, categoryless, +200
    const savingsRegister = (
      await rig.inject({ method: 'GET', url: `/api/accounts/${savings.id}/transactions` })
    ).json() as RegisterResponse;
    const pair = savingsRegister.transactions.find((t) => t.transferAccountId === spending.id);
    expect(pair?.amountMilliunits).toBe(200000);
    expect(pair?.categoryId).toBeNull();

    // no category anywhere → zero rows for E3's activity sum (RTA/categories untouched)
    const categorized = rig.db
      .prepare(
        `SELECT COUNT(*) AS n FROM transactions
         WHERE category_id IS NOT NULL AND is_starting_balance = 0`,
      )
      .get() as { n: number };
    expect(categorized.n).toBe(0);
  });

  it('AC-2: on-budget→tracking requires a category; it lands on the on-budget side only (FR-16)', async () => {
    const missing = await transfer({
      accountId: spending.id,
      transferAccountId: tfsa.id,
      amount: '-200.00',
    });
    expect(missing.statusCode).toBe(400);
    expect((missing.json() as { error: string }).error).toBe(
      'category_required_for_tracking_transfer',
    );

    const res = await transfer({
      accountId: spending.id,
      transferAccountId: tfsa.id,
      amount: '-200.00',
      categoryId: vacationId,
    });
    expect(res.statusCode).toBe(201);
    const { transaction } = res.json() as TransactionMutationResponse;
    expect(transaction.categoryId).toBe(vacationId); // on-budget side carries it

    // the category's activity decreases by $200 (E3 reads exactly this sum)
    const activity = rig.db
      .prepare('SELECT SUM(amount_milliunits) AS total FROM transactions WHERE category_id = ?')
      .get(vacationId) as { total: number };
    expect(activity.total).toBe(-200000);

    // the tracking side has NO category (FR-10)
    const trackingSide = rig.db
      .prepare('SELECT category_id FROM transactions WHERE account_id = ? AND transfer_id IS NOT NULL')
      .get(tfsa.id) as { category_id: string | null };
    expect(trackingSide.category_id).toBeNull();
  });

  it('AC-2 (entered from the tracking side): the category still lands on the on-budget row', async () => {
    const res = await transfer({
      accountId: tfsa.id,
      transferAccountId: spending.id,
      amount: '200.00', // money INTO the TFSA, entered on its own register
      categoryId: vacationId,
    });
    expect(res.statusCode).toBe(201);
    const { transaction } = res.json() as TransactionMutationResponse;
    expect(transaction.categoryId).toBeNull(); // tracking row stays clean (FR-10)
    const onBudgetSide = rig.db
      .prepare('SELECT category_id FROM transactions WHERE account_id = ? AND transfer_id IS NOT NULL')
      .get(spending.id) as { category_id: string | null };
    expect(onBudgetSide.category_id).toBe(vacationId);
  });

  it('AC-3: editing amount/date on one side updates the pair; deleting one side removes both (atomic)', async () => {
    const created = (
      await transfer({
        accountId: spending.id,
        transferAccountId: savings.id,
        amount: '-200.00',
      })
    ).json() as TransactionMutationResponse;
    const id = created.transaction.id;

    const edited = await rig.inject({
      method: 'PATCH',
      url: `/api/transactions/${id}`,
      payload: { amount: '-250.00', date: '2026-06-12' },
    });
    expect(edited.statusCode).toBe(200);
    const pair = rig.db
      .prepare('SELECT amount_milliunits, date FROM transactions WHERE transfer_id IS NOT NULL AND id <> ?')
      .get(id) as { amount_milliunits: number; date: string };
    expect(pair).toEqual({ amount_milliunits: 250000, date: '2026-06-12' });

    const deleted = await rig.inject({ method: 'DELETE', url: `/api/transactions/${id}` });
    expect(deleted.statusCode).toBe(200);
    const balances = (deleted.json() as DeleteTransactionResponse).accountBalances;
    const byAccount = new Map(balances.map((b) => [b.accountId, b.workingBalanceMilliunits]));
    expect(byAccount.get(spending.id)).toBe(1000000);
    expect(byAccount.get(savings.id)).toBe(5000000);
    const remaining = rig.db
      .prepare('SELECT COUNT(*) AS n FROM transactions WHERE transfer_id IS NOT NULL')
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it('AC-4: transfers carry no payee row — "Transfer: <account>" is derived, never suggestable', async () => {
    const created = (
      await transfer({
        accountId: spending.id,
        transferAccountId: savings.id,
        amount: '-200.00',
      })
    ).json() as TransactionMutationResponse;
    expect(created.transaction.payeeId).toBeNull();
    expect(created.transaction.transferAccountName).toBe('Savings');

    const payees = (
      await rig.inject({ method: 'GET', url: '/api/payees' })
    ).json() as PayeesResponse;
    expect(payees.payees.map((p) => p.name)).toEqual(['Starting Balance']);
  });

  it('AC-5: each side clears independently (FR-17)', async () => {
    const created = (
      await transfer({
        accountId: spending.id,
        transferAccountId: savings.id,
        amount: '-200.00',
      })
    ).json() as TransactionMutationResponse;

    const res = await rig.inject({
      method: 'PATCH',
      url: `/api/transactions/${created.transaction.id}`,
      payload: { status: 'cleared' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as TransactionMutationResponse).transaction.status).toBe('cleared');
    const peer = rig.db
      .prepare('SELECT status FROM transactions WHERE transfer_id IS NOT NULL AND id <> ?')
      .get(created.transaction.id) as { status: string };
    expect(peer.status).toBe('uncleared'); // the other bank confirms its own side
  });

  it('cross-check: tracking↔tracking needs no category; on↔on rejects one (FR-10)', async () => {
    const rrsp = await createAccount('RRSP', 'tracking', '0.00');
    const okay = await transfer({
      accountId: tfsa.id,
      transferAccountId: rrsp.id,
      amount: '-50.00',
    });
    expect(okay.statusCode).toBe(201);
    expect((okay.json() as TransactionMutationResponse).transaction.categoryId).toBeNull();

    const rejected = await transfer({
      accountId: spending.id,
      transferAccountId: savings.id,
      amount: '-10.00',
      categoryId: vacationId,
    });
    expect(rejected.statusCode).toBe(400);
    expect((rejected.json() as { error: string }).error).toBe('category_not_allowed_on_transfer');
  });

  it('rejects self-transfers and payee names on transfers', async () => {
    const self = await transfer({
      accountId: spending.id,
      transferAccountId: spending.id,
      amount: '-10.00',
    });
    expect(self.statusCode).toBe(400);
    expect((self.json() as { error: string }).error).toBe('transfer_same_account');

    const withPayee = await transfer({
      accountId: spending.id,
      transferAccountId: savings.id,
      amount: '-10.00',
      payeeName: 'Loblaws',
    });
    expect(withPayee.statusCode).toBe(400);
    expect((withPayee.json() as { error: string }).error).toBe('payee_not_allowed_on_transfer');
  });
});
