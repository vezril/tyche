import type { FastifyInstance, FastifyReply } from 'fastify';
import type Database from 'better-sqlite3';
import type {
  CategoryStructureResponse,
  CreateCategoryGroupRequest,
  CreateCategoryRequest,
  UpdateCategoryGroupRequest,
  UpdateCategoryRequest,
} from '@ynab-clone/shared';
import {
  BudgetError,
  createCategory,
  createGroup,
  deleteCategory,
  deleteGroup,
  getCategoryStructure,
  updateCategory,
  updateGroup,
  type BudgetErrorCode,
} from '../budget/index.js';

/**
 * Category & group management HTTP surface (E3.S6, FR-9). Same translation-
 * layer rules as the other route files: domain rules live in budget/, the
 * session wall + CSRF hook in app.ts covers every route by construction.
 *
 * Every mutation answers with the full recomputed structure payload — the
 * management screen reconciles in one round trip, mirroring the budget grid's
 * contract (ADR-005/ADR-008).
 */

const ERROR_STATUS: Partial<Record<BudgetErrorCode, number>> = {
  category_not_found: 404,
  group_not_found: 404,
  invalid_name: 400,
  duplicate_category_name: 409,
  duplicate_group_name: 409,
  system_protected: 403, // AC-6: the seeded system rows are untouchable
  group_not_empty: 400,
  reassignment_required: 409, // AC-4: choose a target category, then retry
  invalid_reassignment_target: 400,
};

function sendCategoryError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof BudgetError && ERROR_STATUS[err.code] !== undefined) {
    return reply.code(ERROR_STATUS[err.code]!).send({ error: err.code });
  }
  throw err;
}

const NAME_SCHEMA = { type: 'string', minLength: 1, maxLength: 200 } as const;
const INDEX_SCHEMA = { type: 'integer', minimum: 0 } as const;

export function registerCategoryRoutes(app: FastifyInstance, db: Database.Database): void {
  const structure = (): CategoryStructureResponse => getCategoryStructure(db);

  app.get('/api/categories/structure', async (): Promise<CategoryStructureResponse> =>
    structure(),
  );

  // --- groups ---------------------------------------------------------------

  app.post<{ Body: CreateCategoryGroupRequest }>(
    '/api/category-groups',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: { name: NAME_SCHEMA },
          additionalProperties: false,
        },
      },
    },
    async (req, reply): Promise<CategoryStructureResponse> => {
      try {
        createGroup(db, req.body.name);
        return reply.code(201).send(structure()) as never;
      } catch (err) {
        return sendCategoryError(reply, err) as never;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateCategoryGroupRequest }>(
    '/api/category-groups/:id',
    {
      schema: {
        body: {
          type: 'object',
          properties: { name: NAME_SCHEMA, hidden: { type: 'boolean' }, index: INDEX_SCHEMA },
          additionalProperties: false,
        },
      },
    },
    async (req, reply): Promise<CategoryStructureResponse> => {
      try {
        updateGroup(db, req.params.id, req.body);
        return structure();
      } catch (err) {
        return sendCategoryError(reply, err) as never;
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/category-groups/:id',
    async (req, reply): Promise<CategoryStructureResponse> => {
      try {
        deleteGroup(db, req.params.id);
        return structure();
      } catch (err) {
        return sendCategoryError(reply, err) as never;
      }
    },
  );

  // --- categories -------------------------------------------------------------

  app.post<{ Body: CreateCategoryRequest }>(
    '/api/categories',
    {
      schema: {
        body: {
          type: 'object',
          required: ['groupId', 'name'],
          properties: { groupId: { type: 'string', minLength: 1 }, name: NAME_SCHEMA },
          additionalProperties: false,
        },
      },
    },
    async (req, reply): Promise<CategoryStructureResponse> => {
      try {
        createCategory(db, req.body.groupId, req.body.name);
        return reply.code(201).send(structure()) as never;
      } catch (err) {
        return sendCategoryError(reply, err) as never;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateCategoryRequest }>(
    '/api/categories/:id',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            name: NAME_SCHEMA,
            hidden: { type: 'boolean' },
            groupId: { type: 'string', minLength: 1 },
            index: INDEX_SCHEMA,
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply): Promise<CategoryStructureResponse> => {
      try {
        updateCategory(db, req.params.id, req.body);
        return structure();
      } catch (err) {
        return sendCategoryError(reply, err) as never;
      }
    },
  );

  // Delete: history (transactions OR assignments) demands ?reassignTo (AC-4);
  // a clean category deletes without prompting (AC-5).
  app.delete<{ Params: { id: string }; Querystring: { reassignTo?: string } }>(
    '/api/categories/:id',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { reassignTo: { type: 'string', minLength: 1 } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply): Promise<CategoryStructureResponse> => {
      try {
        deleteCategory(db, req.params.id, req.query.reassignTo ?? null);
        return structure();
      } catch (err) {
        return sendCategoryError(reply, err) as never;
      }
    },
  );
}
