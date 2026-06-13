import type { FastifyInstance, FastifyReply } from 'fastify';
import type Database from 'better-sqlite3';
import {
  parseDollarsToMilliunits,
  type AccountResponse,
  type AccountsResponse,
  type AccountBalancesResponse,
  type CategoriesResponse,
  type CreateAccountRequest,
  type CreateTransactionRequest,
  type DeleteTransactionResponse,
  type Milliunits,
  type PayeesResponse,
  type ReconcileAccountRequest,
  type ReconcileAccountResponse,
  type RegisterResponse,
  type SplitLineRequest,
  type TransactionMutationResponse,
  type UpdateAccountRequest,
  type UpdateTransactionRequest,
} from '@ynab-clone/shared';
import {
  accountBalances,
  createAccount,
  createTransaction,
  deleteTransaction,
  getAccount,
  getRegister,
  getTransaction,
  LedgerError,
  listAccounts,
  reconcileAccount,
  searchPayees,
  updateAccount,
  updateTransaction,
  type AccountWithBalances,
  type LedgerErrorCode,
  type SplitLineInput,
} from '../ledger/index.js';
import { listCategories } from '../budget/index.js';
import { matchedTransactionIds } from '../importing/index.js';

/**
 * Ledger HTTP surface (E2.S1–S3, ADR-008 REST). Translation layer only:
 * dollar-string amounts are parsed to milliunits HERE (ADR-004 — the one
 * blessed boundary), domain rules live in ledger/, and every route is behind
 * the global session wall + CSRF hook in app.ts by construction.
 */

const ERROR_STATUS: Record<LedgerErrorCode, number> = {
  account_not_found: 404,
  transaction_not_found: 404,
  category_not_found: 404,
  duplicate_account_name: 409,
  invalid_name: 400,
  invalid_date: 400,
  category_not_allowed_on_tracking_account: 400,
  split_sum_mismatch: 400,
  split_requires_two_lines: 400,
  split_not_allowed_on_tracking_account: 400,
  category_not_allowed_on_split_parent: 400,
  split_line_not_addressable: 400,
  split_transfer_not_supported: 400,
  transfer_same_account: 400,
  category_required_for_tracking_transfer: 400,
  category_not_allowed_on_transfer: 400,
  payee_not_allowed_on_transfer: 400,
  // the lock is a state conflict: retry with ?force=true after user confirmation
  reconciled_transaction_locked: 409,
};

function sendLedgerError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof LedgerError) {
    // details (e.g. discrepancyMilliunits on split_sum_mismatch, FR-15) ride
    // along so the client can NAME the problem in its message.
    return reply.code(ERROR_STATUS[err.code]).send({ error: err.code, ...err.details });
  }
  throw err;
}

/** Whole-cent dollars-string → milliunits; rejects float noise with a 400 (FR-32). */
function parseAmount(reply: FastifyReply, input: string): Milliunits | undefined {
  try {
    return parseDollarsToMilliunits(input);
  } catch {
    void reply.code(400).send({ error: 'invalid_amount' });
    return undefined;
  }
}

function toAccountResponse(a: AccountWithBalances): AccountResponse {
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    onBudget: a.onBudget,
    closed: a.closed,
    workingBalanceMilliunits: a.workingBalanceMilliunits,
    clearedBalanceMilliunits: a.clearedBalanceMilliunits,
  };
}

function balancesOf(db: Database.Database, accountId: string): AccountBalancesResponse {
  const b = accountBalances(db, accountId);
  return {
    accountId,
    workingBalanceMilliunits: b.workingMilliunits,
    clearedBalanceMilliunits: b.clearedMilliunits,
  };
}

const ISO_DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

export function registerLedgerRoutes(app: FastifyInstance, db: Database.Database): void {
  // --- Accounts (E2.S1) ----------------------------------------------------

  app.get<{ Querystring: { includeClosed?: string } }>(
    '/api/accounts',
    async (req): Promise<AccountsResponse> => ({
      accounts: listAccounts(db, { includeClosed: req.query.includeClosed === 'true' }).map(
        toAccountResponse,
      ),
    }),
  );

  app.post<{ Body: CreateAccountRequest }>(
    '/api/accounts',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'type', 'startingBalance'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            type: { type: 'string', enum: ['chequing', 'savings', 'tracking'] },
            startingBalance: { type: 'string', minLength: 1, maxLength: 32 },
            startingDate: { type: 'string', pattern: ISO_DATE_PATTERN },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply): Promise<AccountResponse> => {
      const amount = parseAmount(reply, req.body.startingBalance);
      if (amount === undefined) return reply as never;
      try {
        const account = createAccount(db, {
          name: req.body.name,
          type: req.body.type,
          startingBalanceMilliunits: amount,
          startingDate: req.body.startingDate ?? new Date().toISOString().slice(0, 10),
        });
        return reply.code(201).send(toAccountResponse(getAccount(db, account.id))) as never;
      } catch (err) {
        return sendLedgerError(reply, err) as never;
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/accounts/:id',
    async (req, reply): Promise<AccountResponse> => {
      try {
        return toAccountResponse(getAccount(db, req.params.id));
      } catch (err) {
        return sendLedgerError(reply, err) as never;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateAccountRequest }>(
    '/api/accounts/:id',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            closed: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply): Promise<AccountResponse> => {
      try {
        const patch: { name?: string; closed?: boolean } = {};
        if (req.body.name !== undefined) patch.name = req.body.name;
        if (req.body.closed !== undefined) patch.closed = req.body.closed;
        return toAccountResponse(updateAccount(db, req.params.id, patch));
      } catch (err) {
        return sendLedgerError(reply, err) as never;
      }
    },
  );

  // --- Register (E2.S2) ----------------------------------------------------

  app.get<{
    Params: { id: string };
    Querystring: {
      search?: string;
      payeeId?: string;
      categoryId?: string;
      from?: string;
      to?: string;
      sort?: 'asc' | 'desc';
      limit?: number;
      offset?: number;
    };
  }>(
    '/api/accounts/:id/transactions',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            search: { type: 'string', maxLength: 200 },
            payeeId: { type: 'string' },
            categoryId: { type: 'string' },
            from: { type: 'string', pattern: ISO_DATE_PATTERN },
            to: { type: 'string', pattern: ISO_DATE_PATTERN },
            sort: { type: 'string', enum: ['asc', 'desc'] },
            limit: { type: 'integer', minimum: 1, maximum: 500 },
            offset: { type: 'integer', minimum: 0 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply): Promise<RegisterResponse> => {
      try {
        const page = getRegister(db, req.params.id, req.query);
        const balances = balancesOf(db, req.params.id);
        // E4.S3 AC-3: a merged row offers Unmatch in the register — enriched
        // HERE (web may see both modules) so the ledger stays import-blind.
        const matched = matchedTransactionIds(
          db,
          page.transactions.map((t) => t.id),
        );
        return {
          transactions: page.transactions.map((t) => ({
            ...t,
            hasImportMatch: matched.has(t.id),
          })),
          totalCount: page.totalCount,
          filteredTotalMilliunits: page.filteredTotalMilliunits,
          workingBalanceMilliunits: balances.workingBalanceMilliunits,
          clearedBalanceMilliunits: balances.clearedBalanceMilliunits,
        };
      } catch (err) {
        return sendLedgerError(reply, err) as never;
      }
    },
  );

  // --- Transactions (E2.S3) -------------------------------------------------

  const splitsSchema = {
    type: ['array', 'null'],
    items: {
      type: 'object',
      required: ['amount'],
      properties: {
        amount: { type: 'string', minLength: 1, maxLength: 32 },
        categoryId: { type: ['string', 'null'] },
        memo: { type: 'string', maxLength: 500 },
      },
      additionalProperties: false,
    },
  } as const;

  const transactionBodyProperties = {
    date: { type: 'string', pattern: ISO_DATE_PATTERN },
    amount: { type: 'string', minLength: 1, maxLength: 32 },
    payeeName: { type: ['string', 'null'], maxLength: 200 },
    categoryId: { type: ['string', 'null'] },
    memo: { type: 'string', maxLength: 500 },
    splits: splitsSchema,
  } as const;

  /** Dollars-string lines → milliunit lines; undefined on a 400 already sent. */
  function parseSplits(
    reply: FastifyReply,
    splits: SplitLineRequest[] | undefined,
  ): SplitLineInput[] | undefined {
    if (splits === undefined) return undefined;
    const parsed: SplitLineInput[] = [];
    for (const line of splits) {
      const amount = parseAmount(reply, line.amount);
      if (amount === undefined) return undefined;
      parsed.push({ categoryId: line.categoryId ?? null, amountMilliunits: amount, memo: line.memo ?? '' });
    }
    return parsed;
  }

  /** A transfer mutation moves two balances; everything else moves one (ADR-005). */
  function balancesFor(db_: Database.Database, accountIds: (string | null)[]): AccountBalancesResponse[] {
    return [...new Set(accountIds.filter((id): id is string => id !== null))].map((id) =>
      balancesOf(db_, id),
    );
  }

  app.post<{ Body: CreateTransactionRequest }>(
    '/api/transactions',
    {
      schema: {
        body: {
          type: 'object',
          required: ['accountId', 'date', 'amount'],
          properties: {
            accountId: { type: 'string' },
            transferAccountId: { type: 'string' },
            ...transactionBodyProperties,
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply): Promise<TransactionMutationResponse> => {
      const amount = parseAmount(reply, req.body.amount);
      if (amount === undefined) return reply as never;
      const splits = parseSplits(reply, req.body.splits ?? undefined);
      if (req.body.splits != null && splits === undefined) return reply as never;
      try {
        const transaction = createTransaction(db, {
          accountId: req.body.accountId,
          date: req.body.date,
          amountMilliunits: amount,
          payeeName: req.body.payeeName ?? null,
          categoryId: req.body.categoryId ?? null,
          memo: req.body.memo ?? '',
          ...(splits !== undefined ? { splits } : {}),
          ...(req.body.transferAccountId !== undefined
            ? { transferAccountId: req.body.transferAccountId }
            : {}),
        });
        return reply.code(201).send({
          transaction,
          accountBalances: balancesFor(db, [transaction.accountId, transaction.transferAccountId]),
        } satisfies TransactionMutationResponse) as never;
      } catch (err) {
        return sendLedgerError(reply, err) as never;
      }
    },
  );

  // Editing a reconciled transaction is locked (409); the client retries with
  // ?force=true after the user's explicit confirmation (FR-18).
  app.patch<{
    Params: { id: string };
    Querystring: { force?: string };
    Body: UpdateTransactionRequest;
  }>(
    '/api/transactions/:id',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            ...transactionBodyProperties,
            status: { type: 'string', enum: ['uncleared', 'cleared'] },
          },
          additionalProperties: false,
        },
        querystring: {
          type: 'object',
          properties: { force: { type: 'string', enum: ['true', 'false'] } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply): Promise<TransactionMutationResponse> => {
      let amount: Milliunits | undefined;
      if (req.body.amount !== undefined) {
        amount = parseAmount(reply, req.body.amount);
        if (amount === undefined) return reply as never;
      }
      const splits = parseSplits(reply, req.body.splits ?? undefined);
      if (req.body.splits != null && splits === undefined) return reply as never;
      try {
        const patch: Parameters<typeof updateTransaction>[2] = {};
        if (req.body.date !== undefined) patch.date = req.body.date;
        if (amount !== undefined) patch.amountMilliunits = amount;
        if (req.body.payeeName !== undefined) patch.payeeName = req.body.payeeName;
        if (req.body.categoryId !== undefined) patch.categoryId = req.body.categoryId;
        if (req.body.memo !== undefined) patch.memo = req.body.memo;
        if (req.body.status !== undefined) patch.status = req.body.status;
        if (req.body.splits !== undefined) patch.splits = req.body.splits === null ? null : splits!;
        const transaction = updateTransaction(db, req.params.id, patch, {
          force: req.query.force === 'true',
        });
        return {
          transaction,
          accountBalances: balancesFor(db, [transaction.accountId, transaction.transferAccountId]),
        };
      } catch (err) {
        return sendLedgerError(reply, err) as never;
      }
    },
  );

  app.delete<{ Params: { id: string }; Querystring: { force?: string } }>(
    '/api/transactions/:id',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { force: { type: 'string', enum: ['true', 'false'] } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply): Promise<DeleteTransactionResponse> => {
      try {
        const { accountIds } = deleteTransaction(db, req.params.id, {
          force: req.query.force === 'true',
        });
        return { accountBalances: balancesFor(db, accountIds) };
      } catch (err) {
        return sendLedgerError(reply, err) as never;
      }
    },
  );

  // --- Reconciliation (E2.S7, FR-18) ----------------------------------------

  app.post<{ Params: { id: string }; Body: ReconcileAccountRequest }>(
    '/api/accounts/:id/reconcile',
    {
      schema: {
        body: {
          type: 'object',
          required: ['bankBalance'],
          properties: { bankBalance: { type: 'string', minLength: 1, maxLength: 32 } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply): Promise<ReconcileAccountResponse> => {
      const bankBalance = parseAmount(reply, req.body.bankBalance);
      if (bankBalance === undefined) return reply as never;
      try {
        const result = reconcileAccount(db, req.params.id, {
          bankBalanceMilliunits: bankBalance,
        });
        return {
          adjustmentTransaction: result.adjustmentTransactionId
            ? getTransaction(db, result.adjustmentTransactionId)
            : null,
          reconciledCount: result.reconciledCount,
          accountBalances: [balancesOf(db, req.params.id)],
        };
      } catch (err) {
        return sendLedgerError(reply, err) as never;
      }
    },
  );

  // --- Payees & categories (E2.S3 form data) --------------------------------

  app.get<{ Querystring: { q?: string } }>(
    '/api/payees',
    async (req): Promise<PayeesResponse> => ({ payees: searchPayees(db, req.query.q) }),
  );

  app.get('/api/categories', async (): Promise<CategoriesResponse> => ({
    categories: listCategories(db),
  }));
}
