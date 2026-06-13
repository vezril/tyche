import type { FastifyInstance, FastifyReply } from 'fastify';
import type Database from 'better-sqlite3';
import type { MigrationResponse } from '@ynab-clone/shared';
import { MigrationError, runMigration, type MigrationErrorCode } from '../migration/index.js';

/**
 * YNAB migration HTTP surface (E6, FR-30/31). One endpoint: both export CSVs
 * (Register + Plan) arrive in a single multipart request under the field
 * names `register` and `plan`, so the migration is atomic from the client's
 * point of view — there is no half-uploaded state to reason about. The route
 * is translation only; refusal, reconstruction, parity and the discrepancy
 * report live in migration/. Session wall + CSRF apply by construction
 * (global hook in app.ts).
 */

const MIGRATION_ERROR_STATUS: Record<MigrationErrorCode, number> = {
  register_file_required: 400,
  plan_file_required: 400,
  invalid_register_csv: 400,
  invalid_plan_csv: 400,
  budget_not_empty: 409,
};

function sendMigrationError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof MigrationError) {
    return reply.code(MIGRATION_ERROR_STATUS[err.code]).send({ error: err.code, ...err.details });
  }
  throw err;
}

export function registerMigrationRoutes(app: FastifyInstance, db: Database.Database): void {
  app.post('/api/migration', async (req, reply) => {
    try {
      const uploads = new Map<string, { filename: string; content: string }>();
      for await (const part of req.parts()) {
        if (part.type !== 'file') continue;
        uploads.set(part.fieldname, {
          filename: part.filename,
          content: (await part.toBuffer()).toString('utf8'),
        });
      }
      const register = uploads.get('register');
      const plan = uploads.get('plan');
      if (!register) throw new MigrationError('register_file_required');
      if (!plan) throw new MigrationError('plan_file_required');

      const result: MigrationResponse = runMigration(db, {
        registerCsv: register.content,
        planCsv: plan.content,
        registerFilename: register.filename,
        planFilename: plan.filename,
      });
      return await reply.code(201).send(result);
    } catch (err) {
      return sendMigrationError(reply, err);
    }
  });
}
