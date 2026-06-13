import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '@tyche/shared';
import type {
  AccountResponse,
  ImportFileResponse,
  RegisterResponse,
  RejectTransactionResponse,
  ReviewQueueResponse,
  TransactionMutationResponse,
  TransactionResponse,
  UnmatchTransactionResponse,
} from '@tyche/shared';
import { createTestRig, type TestRig } from './helpers.js';

/**
 * E4 over HTTP: multipart file upload into a chosen account (S1), the review
 * queue with approve/edit/reject (S2), and merge/unmatch surfaces (S3).
 * Everything sits behind the session wall + CSRF by construction — pinned
 * here for the new mutating routes.
 */

const OFX = readFileSync(join(import.meta.dirname, '../importing/fixtures/rbc-chequing.ofx'), 'utf8');
const CSV = readFileSync(join(import.meta.dirname, '../importing/fixtures/rbc-chequing.csv'), 'utf8');

const BOUNDARY = '----tycheTestBoundary42';

function multipart(filename: string, content: string): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  return {
    payload: Buffer.from(
      [
        `--${BOUNDARY}`,
        `content-disposition: form-data; name="file"; filename="${filename}"`,
        'content-type: application/octet-stream',
        '',
        content,
        `--${BOUNDARY}--`,
        '',
      ].join('\r\n'),
    ),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  };
}

describe('file import + review API (E4)', () => {
  let rig: TestRig;
  let account: AccountResponse;
  let groceriesId: string;

  async function upload(filename: string, content: string, accountId = account.id) {
    const { payload, headers } = multipart(filename, content);
    return rig.inject({
      method: 'POST',
      url: `/api/accounts/${accountId}/import`,
      payload,
      headers,
    });
  }

  async function register(): Promise<RegisterResponse> {
    const res = await rig.inject({
      method: 'GET',
      url: `/api/accounts/${account.id}/transactions?limit=500`,
    });
    return res.json() as RegisterResponse;
  }

  async function queue(): Promise<ReviewQueueResponse> {
    const res = await rig.inject({ method: 'GET', url: '/api/review' });
    return res.json() as ReviewQueueResponse;
  }

  beforeEach(async () => {
    rig = await createTestRig();
    const created = await rig.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        name: 'Chequing',
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

  // --- E4.S1: upload -----------------------------------------------------------

  it('S1 AC-1: an RBC OFX upload lands as unapproved register rows with parsed dates/payees/signed amounts', async () => {
    const res = await upload('rbc-chequing.ofx', OFX);
    expect(res.statusCode).toBe(201);
    const body = res.json() as ImportFileResponse;
    expect(body).toMatchObject({
      format: 'ofx',
      createdCount: 8,
      mergedCount: 0,
      duplicateCount: 1, // the in-file duplicate FITID
      rejectedCount: 0,
    });
    expect(body.errors).toHaveLength(2); // AC-3: per-row reasons travel to the client
    expect(body.accountBalances[0]?.accountId).toBe(account.id);

    const page = await register();
    const tims = page.transactions.find((t) => t.payeeName === 'TIM HORTONS #2241');
    expect(tims).toMatchObject({
      date: '2026-06-01',
      amountMilliunits: -52160,
      status: 'cleared',
      approved: false,
      source: 'file',
    });
  });

  it('S1 AC-2: an RBC CSV upload populates the review queue with string-parsed milliunits', async () => {
    const res = await upload('rbc-chequing.csv', CSV);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ format: 'csv', createdCount: 8 });
    const { items, totalCount } = await queue();
    expect(totalCount).toBe(8);
    const payroll = items.find((i) => i.transaction.payeeName === 'PAYROLL DEPOSIT');
    expect(payroll?.transaction.amountMilliunits).toBe(2417330);
    expect(payroll?.accountName).toBe('Chequing');
  });

  it('S1 AC-6: the target account is chosen by the user — an unknown account 404s', async () => {
    const res = await upload('june.ofx', OFX, 'no-such-account');
    expect(res.statusCode).toBe(404);
  });

  it('rejects garbage and empty uploads with named reasons', async () => {
    expect((await upload('mystery.bin', 'not a bank file')).statusCode).toBe(400);
    expect((await upload('empty.csv', '   ')).statusCode).toBe(400);
    const missing = await rig.inject({
      method: 'POST',
      url: `/api/accounts/${account.id}/import`,
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: Buffer.from(`--${BOUNDARY}--\r\n`),
    });
    expect(missing.statusCode).toBe(400);
  });

  it('upload requires a session and the CSRF header like every /api mutation', async () => {
    const { payload, headers } = multipart('june.ofx', OFX);
    const noCsrf = await rig.app.inject({
      method: 'POST',
      url: `/api/accounts/${account.id}/import`,
      payload,
      headers: { ...headers, cookie: rig.authed.cookie },
    });
    expect(noCsrf.statusCode).toBe(403);
    const noSession = await rig.app.inject({
      method: 'POST',
      url: `/api/accounts/${account.id}/import`,
      payload,
      headers: { ...headers, [CSRF_HEADER]: '1' },
    });
    expect(noSession.statusCode).toBe(401);
  });

  // --- E4.S2: review queue -------------------------------------------------------

  it('S2 AC-1: the queue lists unapproved rows newest first with account, suggestion, and amount', async () => {
    // teach a payee suggestion first, then import
    await rig.inject({
      method: 'POST',
      url: '/api/transactions',
      payload: {
        accountId: account.id,
        date: '2026-05-01',
        amount: '-10.00',
        payeeName: 'NETFLIX.COM',
        categoryId: groceriesId,
      },
    });
    await upload('rbc-chequing.ofx', OFX);
    const { items } = await queue();
    expect(items.map((i) => i.transaction.date)).toEqual(
      [...items.map((i) => i.transaction.date)].sort().reverse(), // newest first
    );
    const netflix = items.find((i) => i.transaction.payeeName === 'NETFLIX.COM');
    // suggestion was applied to the row at import time (S1 AC-4)
    expect(netflix?.transaction.categoryId).toBe(groceriesId);
  });

  it('S2 AC-2/AC-5: approving with a category edit keeps amount/date and teaches the payee suggestion', async () => {
    await upload('rbc-chequing.ofx', OFX);
    const { items } = await queue();
    const tims = items.find((i) => i.transaction.payeeName === 'TIM HORTONS #2241')!;
    const res = await rig.inject({
      method: 'POST',
      url: `/api/transactions/${tims.transaction.id}/approve`,
      payload: { categoryId: groceriesId, memo: 'coffee run' },
    });
    expect(res.statusCode).toBe(200);
    const { transaction } = res.json() as TransactionMutationResponse;
    expect(transaction).toMatchObject({
      approved: true,
      categoryId: groceriesId,
      memo: 'coffee run',
      amountMilliunits: -52160, // imported identity untouched
      date: '2026-06-01',
    });
    // FR-19: the confirmed pairing is now the payee's suggestion
    expect(
      rig.db
        .prepare('SELECT last_category_id FROM payees WHERE name = ?')
        .get('TIM HORTONS #2241'),
    ).toEqual({ last_category_id: groceriesId });
    // approval is amount/date-proof at the schema level too: Fastify's Ajv
    // (removeAdditional) strips fields the schema doesn't allow, and the
    // domain command doesn't accept them either — the amount cannot move.
    const sneaky = await rig.inject({
      method: 'POST',
      url: `/api/transactions/${tims.transaction.id}/approve`,
      payload: { amount: '-999.99', date: '2027-01-01' },
    });
    const after = (sneaky.json() as TransactionMutationResponse).transaction;
    expect(after).toMatchObject({ amountMilliunits: -52160, date: '2026-06-01' });
  });

  it('S2 AC-4: a rejected transaction leaves the register and never returns on re-import', async () => {
    await upload('rbc-chequing.ofx', OFX);
    const { items } = await queue();
    const netflix = items.find((i) => i.transaction.payeeName === 'NETFLIX.COM')!;
    const res = await rig.inject({
      method: 'POST',
      url: `/api/transactions/${netflix.transaction.id}/reject`,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as RejectTransactionResponse).rememberedExternalId).toBe('C1A0006');

    const page = await register();
    expect(page.transactions.some((t) => t.payeeName === 'NETFLIX.COM')).toBe(false);

    const again = await upload('rbc-chequing.ofx', OFX);
    expect(again.json()).toMatchObject({ createdCount: 0, rejectedCount: 1 });
    expect((await register()).transactions.some((t) => t.payeeName === 'NETFLIX.COM')).toBe(false);
  });

  it('rejecting an approved transaction is refused (409) — delete is the path for those', async () => {
    const created = await rig.inject({
      method: 'POST',
      url: '/api/transactions',
      payload: { accountId: account.id, date: '2026-06-10', amount: '-5.00', payeeName: 'Corner store' },
    });
    const { transaction } = created.json() as TransactionMutationResponse;
    const res = await rig.inject({
      method: 'POST',
      url: `/api/transactions/${transaction.id}/reject`,
    });
    expect(res.statusCode).toBe(409);
  });

  // --- E4.S3: merge + unmatch over HTTP -------------------------------------------

  async function manualThenImport(): Promise<TransactionResponse> {
    const created = await rig.inject({
      method: 'POST',
      url: '/api/transactions',
      payload: {
        accountId: account.id,
        date: '2026-06-03',
        amount: '-43.10',
        payeeName: 'Groceries run',
        categoryId: groceriesId,
        memo: 'my own note',
      },
    });
    const manual = (created.json() as TransactionMutationResponse).transaction;
    const ofx = OFX.replace(/<BANKTRANLIST>[\s\S]*<\/BANKTRANLIST>/, `<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260605120000[-5:EST]
<TRNAMT>-43.10
<FITID>MERGE01
<NAME>GROCERIES BANKSIDE
</STMTTRN>
</BANKTRANLIST>`);
    const res = await upload('overlap.ofx', ofx);
    expect((res.json() as ImportFileResponse).mergedCount).toBe(1);
    return manual;
  }

  it('S3 AC-2/AC-5: the merge is one row, flagged as a match in the queue and the register', async () => {
    const manual = await manualThenImport();
    const { items } = await queue();
    const item = items.find((i) => i.transaction.id === manual.id)!;
    expect(item.match).toMatchObject({
      importedDate: '2026-06-05',
      importedPayee: 'GROCERIES BANKSIDE',
      importedAmountMilliunits: -43100,
      externalId: 'MERGE01',
    });
    expect(item.transaction).toMatchObject({ memo: 'my own note', categoryId: groceriesId });

    const page = await register();
    const row = page.transactions.find((t) => t.id === manual.id);
    expect(row?.hasImportMatch).toBe(true); // the register's Unmatch affordance
  });

  it('S3 AC-3: unmatch over HTTP reverts the manual row and restores the import as unapproved', async () => {
    const manual = await manualThenImport();
    const res = await rig.inject({
      method: 'POST',
      url: `/api/transactions/${manual.id}/unmatch`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as UnmatchTransactionResponse;
    expect(body.revertedTransaction).toMatchObject({
      id: manual.id,
      approved: true,
      status: 'uncleared',
    });
    expect(body.restoredTransaction).toMatchObject({
      payeeName: 'GROCERIES BANKSIDE',
      date: '2026-06-05',
      approved: false,
      status: 'cleared',
      source: 'file',
    });
    // unmatching a row with no match 404s
    const again = await rig.inject({
      method: 'POST',
      url: `/api/transactions/${manual.id}/unmatch`,
    });
    expect(again.statusCode).toBe(404);
  });
});
