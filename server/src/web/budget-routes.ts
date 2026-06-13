import type { FastifyInstance, FastifyReply } from 'fastify';
import type Database from 'better-sqlite3';
import {
  parseDollarsToMilliunits,
  type BudgetMonthResponse,
  type MoveMoneyRequest,
  type PutAssignmentRequest,
} from '@ynab-clone/shared';
import {
  BudgetError,
  getBudgetMonth,
  moveMoney,
  setAssignedAmount,
  type BudgetErrorCode,
} from '../budget/index.js';

/**
 * Budget HTTP surface (E3.S1, ADR-008 REST). Same translation-layer rules as
 * the ledger routes: dollar strings parsed to milliunits HERE (ADR-004),
 * domain rules in budget/, session wall + CSRF applied globally by app.ts.
 *
 * Both routes answer with the full recomputed month payload — the mutation
 * returns everything the grid needs to reconcile optimistic state in one
 * round trip (ADR-005/ADR-008; recompute is single-digit ms at the ceiling).
 */

// The E3.S6 management codes are mapped by category-routes.ts; only the codes
// these grid/assignment/move routes can raise are listed here.
const ERROR_STATUS: Partial<Record<BudgetErrorCode, number>> = {
  category_not_found: 404,
  cannot_assign_to_inflow_category: 400,
  invalid_month: 400,
  move_amount_not_positive: 400,
  move_requires_two_categories: 400,
};

function sendBudgetError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof BudgetError && ERROR_STATUS[err.code] !== undefined) {
    return reply.code(ERROR_STATUS[err.code]!).send({ error: err.code });
  }
  throw err;
}

// Anchored YYYY-MM with 01–12 months; rejects garbage before the handler runs.
const MONTH_PARAM_SCHEMA = {
  type: 'object',
  required: ['month'],
  properties: { month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' } },
} as const;

export function registerBudgetRoutes(
  app: FastifyInstance,
  db: Database.Database,
  now: () => Date,
): void {
  const today = (): string => now().toISOString().slice(0, 10);

  app.get<{ Params: { month: string } }>(
    '/api/budget/:month',
    { schema: { params: MONTH_PARAM_SCHEMA } },
    async (req, reply): Promise<BudgetMonthResponse> => {
      try {
        return getBudgetMonth(db, req.params.month, today());
      } catch (err) {
        return sendBudgetError(reply, err) as never;
      }
    },
  );

  app.put<{ Params: { month: string; categoryId: string }; Body: PutAssignmentRequest }>(
    '/api/budget/:month/categories/:categoryId',
    {
      schema: {
        params: {
          ...MONTH_PARAM_SCHEMA,
          required: ['month', 'categoryId'],
          properties: {
            ...MONTH_PARAM_SCHEMA.properties,
            categoryId: { type: 'string', minLength: 1 },
          },
        },
        body: {
          type: 'object',
          required: ['assigned'],
          properties: { assigned: { type: 'string', minLength: 1, maxLength: 32 } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply): Promise<BudgetMonthResponse> => {
      let amount;
      try {
        amount = parseDollarsToMilliunits(req.body.assigned);
      } catch {
        return reply.code(400).send({ error: 'invalid_amount' }) as never;
      }
      try {
        setAssignedAmount(db, req.params.categoryId, req.params.month, amount);
        return getBudgetMonth(db, req.params.month, today());
      } catch (err) {
        return sendBudgetError(reply, err) as never;
      }
    },
  );

  // E3.S4 (FR-5): category→category move = paired assignment adjustments in
  // one DB transaction; answers with the full recomputed month like the PUT.
  app.post<{ Params: { month: string }; Body: MoveMoneyRequest }>(
    '/api/budget/:month/move',
    {
      schema: {
        params: MONTH_PARAM_SCHEMA,
        body: {
          type: 'object',
          required: ['fromCategoryId', 'toCategoryId', 'amount'],
          properties: {
            fromCategoryId: { type: 'string', minLength: 1 },
            toCategoryId: { type: 'string', minLength: 1 },
            amount: { type: 'string', minLength: 1, maxLength: 32 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply): Promise<BudgetMonthResponse> => {
      let amount;
      try {
        amount = parseDollarsToMilliunits(req.body.amount);
      } catch {
        return reply.code(400).send({ error: 'invalid_amount' }) as never;
      }
      try {
        moveMoney(db, req.params.month, req.body.fromCategoryId, req.body.toCategoryId, amount);
        return getBudgetMonth(db, req.params.month, today());
      } catch (err) {
        return sendBudgetError(reply, err) as never;
      }
    },
  );
}
