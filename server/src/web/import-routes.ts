import type { FastifyInstance, FastifyReply } from 'fastify';
import type Database from 'better-sqlite3';
import type {
  AccountBalancesResponse,
  ApproveTransactionRequest,
  ImportFileResponse,
  RejectTransactionResponse,
  ReviewQueueResponse,
  TransactionMutationResponse,
  UnmatchTransactionResponse,
} from '@tyche/shared';
import {
  accountBalances,
  approveTransaction,
  LedgerError,
  type ApproveTransactionEdits,
  type LedgerErrorCode,
} from '../ledger/index.js';
import {
  ImportError,
  listReviewQueue,
  parseImportFile,
  rejectTransaction,
  runImport,
  unmatchTransaction,
  type ImportErrorCode,
} from '../importing/index.js';

/**
 * Import + review HTTP surface (E4.S1–S3, FR-22..25). Translation layer only:
 * multipart decoding and error→status mapping live here; parsing, matching,
 * and review semantics live in importing/; every ledger write happens through
 * the ledger command seam. All routes sit behind the global session wall +
 * CSRF hook in app.ts by construction.
 */

const IMPORT_ERROR_STATUS: Record<ImportErrorCode, number> = {
  empty_file: 400,
  unsupported_format: 400,
  file_required: 400,
  transaction_already_approved: 409,
  match_not_found: 404,
  // Plaid link + sync (E5.S1/S2)
  plaid_not_configured: 400,
  plaid_item_not_found: 404,
  plaid_item_not_active: 409,
  plaid_account_link_not_found: 404,
  // E7.S1 AC-3 (ADR-007): restore without the original MASTER_KEY → re-link
  plaid_token_unreadable: 409,
};

const LEDGER_ERROR_STATUS: Partial<Record<LedgerErrorCode, number>> = {
  account_not_found: 404,
  transaction_not_found: 404,
  category_not_found: 404,
  split_line_not_addressable: 400,
  category_not_allowed_on_tracking_account: 400,
  category_not_allowed_on_split_parent: 400,
  category_not_allowed_on_transfer: 400,
  category_required_for_tracking_transfer: 400,
  payee_not_allowed_on_transfer: 400,
};

/** Shared by import-routes and plaid-routes — one error→status mapping for the import domain. */
export function sendImportError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ImportError) {
    return reply.code(IMPORT_ERROR_STATUS[err.code]).send({ error: err.code, ...err.details });
  }
  if (err instanceof LedgerError) {
    return reply
      .code(LEDGER_ERROR_STATUS[err.code] ?? 400)
      .send({ error: err.code, ...err.details });
  }
  throw err;
}

export function balancesOf(db: Database.Database, accountIds: string[]): AccountBalancesResponse[] {
  return [...new Set(accountIds)].map((accountId) => {
    const b = accountBalances(db, accountId);
    return {
      accountId,
      workingBalanceMilliunits: b.workingMilliunits,
      clearedBalanceMilliunits: b.clearedMilliunits,
    };
  });
}

export function registerImportRoutes(app: FastifyInstance, db: Database.Database): void {
  // --- File upload: the file backend of the importer port (E4.S1) -----------
  //
  // The target account is in the URL — files carry no reliable account
  // mapping, so the user must choose before import (S1 AC-6).
  app.post<{ Params: { id: string } }>('/api/accounts/:id/import', async (req, reply) => {
    try {
      const upload = await req.file();
      if (!upload) throw new ImportError('file_required');
      const content = (await upload.toBuffer()).toString('utf8');
      const { format, staged, errors } = parseImportFile(upload.filename, content);
      const summary = runImport(db, {
        accountId: req.params.id,
        source: 'file',
        filename: upload.filename,
        format,
        staged,
        parseErrors: errors,
      });
      return reply.code(201).send({
        batchId: summary.batchId,
        format,
        createdCount: summary.createdIds.length,
        mergedCount: summary.mergedIds.length,
        duplicateCount: summary.duplicateCount,
        rejectedCount: summary.rejectedCount,
        errors: summary.errors,
        accountBalances: balancesOf(db, [req.params.id]),
      } satisfies ImportFileResponse);
    } catch (err) {
      return sendImportError(reply, err);
    }
  });

  // --- Review queue (E4.S2, FR-22) -------------------------------------------

  app.get('/api/review', async (): Promise<ReviewQueueResponse> => {
    const items = listReviewQueue(db);
    return { items, totalCount: items.length };
  });

  app.post<{ Params: { id: string }; Body: ApproveTransactionRequest }>(
    '/api/transactions/:id/approve',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            // Only review-editable fields — amount/date are structurally NOT
            // accepted here, so approval can never alter them (S2 AC-2).
            categoryId: { type: ['string', 'null'] },
            payeeName: { type: ['string', 'null'], maxLength: 200 },
            memo: { type: 'string', maxLength: 500 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply): Promise<TransactionMutationResponse> => {
      try {
        const edits: ApproveTransactionEdits = {};
        if (req.body?.categoryId !== undefined) edits.categoryId = req.body.categoryId;
        if (req.body?.payeeName !== undefined) edits.payeeName = req.body.payeeName;
        if (req.body?.memo !== undefined) edits.memo = req.body.memo;
        const transaction = approveTransaction(db, req.params.id, edits);
        return { transaction, accountBalances: balancesOf(db, [transaction.accountId]) };
      } catch (err) {
        return sendImportError(reply, err) as never;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/transactions/:id/reject',
    async (req, reply): Promise<RejectTransactionResponse> => {
      try {
        const result = rejectTransaction(db, req.params.id);
        return {
          rememberedExternalId: result.rememberedExternalId,
          accountBalances: balancesOf(db, result.accountIds),
        };
      } catch (err) {
        return sendImportError(reply, err) as never;
      }
    },
  );

  // --- Unmatch: undo a T2 merge (E4.S3 AC-3) ---------------------------------

  app.post<{ Params: { id: string } }>(
    '/api/transactions/:id/unmatch',
    async (req, reply): Promise<UnmatchTransactionResponse> => {
      try {
        const result = unmatchTransaction(db, req.params.id);
        return {
          revertedTransaction: result.revertedTransaction,
          restoredTransaction: result.restoredTransaction,
          accountBalances: balancesOf(db, [result.revertedTransaction.accountId]),
        };
      } catch (err) {
        return sendImportError(reply, err) as never;
      }
    },
  );
}
