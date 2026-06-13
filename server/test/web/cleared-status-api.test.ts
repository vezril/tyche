import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { milliunits } from '@tyche/shared';
import type {
  AccountResponse,
  RegisterResponse,
  TransactionMutationResponse,
} from '@tyche/shared';
import { createTransaction } from '../../src/ledger/index.js';
import { createTestRig, type TestRig } from './helpers.js';

// E2.S6 over HTTP: the uncleared→cleared→reconciled lifecycle (FR-17),
// cleared vs working balances derived on read (ADR-005), the reconciled lock
// (FR-18, implemented here so S7 only adds the flow), and per-source status
// defaults (manual=uncleared, bank imports=cleared).

describe('cleared status API (E2.S6)', () => {
  let rig: TestRig;
  let account: AccountResponse;

  beforeEach(async () => {
    rig = await createTestRig();
    account = (
      await rig.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: {
          name: 'Spending',
          type: 'chequing',
          startingBalance: '1000.00',
          startingDate: '2026-01-01',
        },
      })
    ).json() as AccountResponse;
  });
  afterEach(async () => {
    await rig.cleanup();
  });

  const addTransaction = async (amount: string): Promise<TransactionMutationResponse> =>
    (
      await rig.inject({
        method: 'POST',
        url: '/api/transactions',
        payload: { accountId: account.id, date: '2026-06-10', amount, payeeName: 'Shop' },
      })
    ).json() as TransactionMutationResponse;

  it('AC-1: toggling the cleared flag moves the amount between cleared and uncleared figures (FR-17 verified-by)', async () => {
    const created = await addTransaction('-45.20');
    // manual entry starts uncleared: working moved, cleared did not
    expect(created.accountBalances[0]).toMatchObject({
      workingBalanceMilliunits: 1000000 - 45200,
      clearedBalanceMilliunits: 1000000,
    });

    const cleared = await rig.inject({
      method: 'PATCH',
      url: `/api/transactions/${created.transaction.id}`,
      payload: { status: 'cleared' },
    });
    expect(cleared.statusCode).toBe(200);
    expect((cleared.json() as TransactionMutationResponse).accountBalances[0]).toMatchObject({
      workingBalanceMilliunits: 1000000 - 45200,
      clearedBalanceMilliunits: 1000000 - 45200,
    });

    const uncleared = await rig.inject({
      method: 'PATCH',
      url: `/api/transactions/${created.transaction.id}`,
      payload: { status: 'uncleared' },
    });
    expect((uncleared.json() as TransactionMutationResponse).accountBalances[0]).toMatchObject({
      workingBalanceMilliunits: 1000000 - 45200,
      clearedBalanceMilliunits: 1000000,
    });
  });

  it('AC-2: working and cleared balances each equal the corresponding sum over transactions (NFR-12)', async () => {
    await addTransaction('-45.20'); // uncleared
    const second = await addTransaction('-10.00');
    await rig.inject({
      method: 'PATCH',
      url: `/api/transactions/${second.transaction.id}`,
      payload: { status: 'cleared' },
    });

    const register = (
      await rig.inject({ method: 'GET', url: `/api/accounts/${account.id}/transactions` })
    ).json() as RegisterResponse;
    // independent recompute from the rows themselves
    const working = register.transactions.reduce((sum, t) => sum + t.amountMilliunits, 0);
    const cleared = register.transactions
      .filter((t) => t.status === 'cleared' || t.status === 'reconciled')
      .reduce((sum, t) => sum + t.amountMilliunits, 0);
    expect(register.workingBalanceMilliunits).toBe(working);
    expect(register.clearedBalanceMilliunits).toBe(cleared);
    expect(register.workingBalanceMilliunits).toBe(1000000 - 45200 - 10000);
    expect(register.clearedBalanceMilliunits).toBe(1000000 - 10000);
  });

  it('AC-3: a reconciled transaction rejects a status toggle without explicit confirmation, accepts with force (FR-18)', async () => {
    const created = await addTransaction('-45.20');
    rig.db
      .prepare("UPDATE transactions SET status = 'reconciled' WHERE id = ?")
      .run(created.transaction.id);

    const locked = await rig.inject({
      method: 'PATCH',
      url: `/api/transactions/${created.transaction.id}`,
      payload: { status: 'uncleared' },
    });
    expect(locked.statusCode).toBe(409);
    expect((locked.json() as { error: string }).error).toBe('reconciled_transaction_locked');

    const forced = await rig.inject({
      method: 'PATCH',
      url: `/api/transactions/${created.transaction.id}?force=true`,
      payload: { status: 'uncleared' },
    });
    expect(forced.statusCode).toBe(200);
    expect((forced.json() as TransactionMutationResponse).transaction.status).toBe('uncleared');

    // deletes are locked the same way
    const other = await addTransaction('-1.00');
    rig.db
      .prepare("UPDATE transactions SET status = 'reconciled' WHERE id = ?")
      .run(other.transaction.id);
    const deleteLocked = await rig.inject({
      method: 'DELETE',
      url: `/api/transactions/${other.transaction.id}`,
    });
    expect(deleteLocked.statusCode).toBe(409);
    const deleteForced = await rig.inject({
      method: 'DELETE',
      url: `/api/transactions/${other.transaction.id}?force=true`,
    });
    expect(deleteForced.statusCode).toBe(200);
  });

  it('AC-3: status cannot jump straight to reconciled through the API (only the reconcile flow sets it)', async () => {
    const created = await addTransaction('-45.20');
    const res = await rig.inject({
      method: 'PATCH',
      url: `/api/transactions/${created.transaction.id}`,
      payload: { status: 'reconciled' },
    });
    expect(res.statusCode).toBe(400); // schema enum: uncleared|cleared only
  });

  it('AC-5: bank-imported rows default to cleared; manual entries default to uncleared (architecture §6)', async () => {
    // through the single ledger write seam that E4/E5 importing will use
    const imported = createTransaction(rig.db, {
      accountId: account.id,
      date: '2026-06-10',
      amountMilliunits: milliunits(-20000),
      payeeName: 'Bank Row',
      source: 'plaid',
      approved: false,
    });
    expect(imported.status).toBe('cleared');

    const fileImported = createTransaction(rig.db, {
      accountId: account.id,
      date: '2026-06-10',
      amountMilliunits: milliunits(-30000),
      payeeName: 'File Row',
      source: 'file',
      approved: false,
    });
    expect(fileImported.status).toBe('cleared');

    const manual = await addTransaction('-1.00');
    expect(manual.transaction.status).toBe('uncleared');
  });
});
