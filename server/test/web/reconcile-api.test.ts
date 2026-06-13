import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AccountResponse,
  ReconcileAccountResponse,
  RegisterResponse,
  TransactionMutationResponse,
} from '@tyche/shared';
import { RECONCILIATION_ADJUSTMENT_CATEGORY_ID } from '../../src/db/seed.js';
import { createTestRig, type TestRig } from './helpers.js';

// E2.S7 over HTTP: enter the bank balance → adjustment for any difference
// (categorized to the SEEDED system category — E1.S1 created it, this flow
// only uses it) → lock cleared rows as reconciled. FR-18 verified-by: the
// post-reconciliation cleared balance equals the entered bank balance, and
// reconciled rows demand explicit confirmation to edit.

describe('reconciliation API (E2.S7)', () => {
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
          startingBalance: '1000.00', // cleared starting-balance row
          startingDate: '2026-01-01',
        },
      })
    ).json() as AccountResponse;
  });
  afterEach(async () => {
    await rig.cleanup();
  });

  const addTransaction = async (
    amount: string,
    status?: 'cleared',
  ): Promise<TransactionMutationResponse> => {
    const created = (
      await rig.inject({
        method: 'POST',
        url: '/api/transactions',
        payload: { accountId: account.id, date: '2026-06-01', amount, payeeName: 'Shop' },
      })
    ).json() as TransactionMutationResponse;
    if (status === 'cleared') {
      await rig.inject({
        method: 'PATCH',
        url: `/api/transactions/${created.transaction.id}`,
        payload: { status: 'cleared' },
      });
    }
    return created;
  };

  const reconcile = async (bankBalance: string): Promise<ReconcileAccountResponse> => {
    const res = await rig.inject({
      method: 'POST',
      url: `/api/accounts/${account.id}/reconcile`,
      payload: { bankBalance },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as ReconcileAccountResponse;
  };

  it('AC-3: zero difference → no adjustment; all cleared rows lock as reconciled and the cleared balance equals the bank balance', async () => {
    await addTransaction('-100.00', 'cleared');
    await addTransaction('-25.00'); // stays uncleared — untouched by the flow

    const result = await reconcile('900.00'); // exactly the cleared balance
    expect(result.adjustmentTransaction).toBeNull();
    expect(result.reconciledCount).toBe(2); // starting balance + cleared row
    expect(result.accountBalances[0]?.clearedBalanceMilliunits).toBe(900000);

    const register = (
      await rig.inject({ method: 'GET', url: `/api/accounts/${account.id}/transactions` })
    ).json() as RegisterResponse;
    const statuses = register.transactions.map((t) => t.status).sort();
    expect(statuses).toEqual(['reconciled', 'reconciled', 'uncleared']);
  });

  it('AC-1/AC-2: a nonzero difference produces a cleared adjustment for exactly the difference, categorized to the seeded system category, and the difference becomes $0 (FR-18 verified-by)', async () => {
    await addTransaction('-100.00', 'cleared'); // cleared balance: $900
    const result = await reconcile('880.50'); // bank says $880.50 → diff −$19.50

    const adjustment = result.adjustmentTransaction;
    expect(adjustment).not.toBeNull();
    expect(adjustment?.amountMilliunits).toBe(-19500);
    expect(adjustment?.categoryId).toBe(RECONCILIATION_ADJUSTMENT_CATEGORY_ID);
    expect(adjustment?.status).toBe('reconciled'); // created cleared, swept by the lock
    expect(adjustment?.payeeName).toBe('Reconciliation Balance Adjustment');

    // post-reconciliation cleared balance EQUALS the entered bank balance
    expect(result.accountBalances[0]?.clearedBalanceMilliunits).toBe(880500);
    // and the difference is now $0: reconciling again changes nothing
    const again = await reconcile('880.50');
    expect(again.adjustmentTransaction).toBeNull();
    expect(again.reconciledCount).toBe(0);
  });

  it('AC-2: an upward difference creates a positive (inflow) adjustment', async () => {
    const result = await reconcile('1010.00');
    expect(result.adjustmentTransaction?.amountMilliunits).toBe(10000);
    expect(result.accountBalances[0]?.clearedBalanceMilliunits).toBe(1010000);
  });

  it('AC-4: editing or deleting a reconciled transaction afterwards requires explicit confirmation', async () => {
    const t = await addTransaction('-100.00', 'cleared');
    await reconcile('900.00');

    const editLocked = await rig.inject({
      method: 'PATCH',
      url: `/api/transactions/${t.transaction.id}`,
      payload: { memo: 'changed' },
    });
    expect(editLocked.statusCode).toBe(409);
    expect((editLocked.json() as { error: string }).error).toBe('reconciled_transaction_locked');

    const editForced = await rig.inject({
      method: 'PATCH',
      url: `/api/transactions/${t.transaction.id}?force=true`,
      payload: { memo: 'changed' },
    });
    expect(editForced.statusCode).toBe(200);

    const deleteLocked = await rig.inject({
      method: 'DELETE',
      url: `/api/transactions/${t.transaction.id}`,
    });
    expect(deleteLocked.statusCode).toBe(409);
  });

  it('AC-5: uncleared rows survive the flow untouched and can be toggled during it', async () => {
    const uncleared = await addTransaction('-25.00');
    // mid-flow toggle (the modal lists these for quick clearing, NFR-9)
    await rig.inject({
      method: 'PATCH',
      url: `/api/transactions/${uncleared.transaction.id}`,
      payload: { status: 'cleared' },
    });
    const result = await reconcile('975.00');
    expect(result.adjustmentTransaction).toBeNull();
    expect(result.accountBalances[0]?.clearedBalanceMilliunits).toBe(975000);
  });

  it('tracking accounts reconcile with an UNCATEGORIZED adjustment (FR-10)', async () => {
    const tfsa = (
      await rig.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'TFSA', type: 'tracking', startingBalance: '5000.00' },
      })
    ).json() as AccountResponse;
    const res = await rig.inject({
      method: 'POST',
      url: `/api/accounts/${tfsa.id}/reconcile`,
      payload: { bankBalance: '5100.00' },
    });
    expect(res.statusCode).toBe(200);
    const result = res.json() as ReconcileAccountResponse;
    expect(result.adjustmentTransaction?.amountMilliunits).toBe(100000);
    expect(result.adjustmentTransaction?.categoryId).toBeNull();
    expect(result.accountBalances[0]?.clearedBalanceMilliunits).toBe(5100000);
  });

  it('reconciliation is atomic and 404s on unknown accounts', async () => {
    const res = await rig.inject({
      method: 'POST',
      url: '/api/accounts/nope/reconcile',
      payload: { bankBalance: '1.00' },
    });
    expect(res.statusCode).toBe(404);
  });
});
