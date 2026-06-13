import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type Database from 'better-sqlite3';
import type {
  BackupRunResponse,
  BackupsResponse,
  BootConsistencyResponse,
  ConsistencyCheckResponse,
} from '@tyche/shared';
import {
  createBackup,
  DEFAULT_BACKUP_RETENTION,
  listBackups,
  pruneBackups,
} from '../admin/backup.js';
import { budgetCsvLines, registerCsvLines } from '../admin/export.js';
import { runConsistencyCheck } from '../budget/index.js';
import { monthOfDate } from '../budget/month.js';

/**
 * Ops surface (E7): backup (FR-35), CSV export (FR-36), and the NFR-12
 * consistency check — all behind the session wall like every /api route, and
 * all REST/curl-able by design (ADR-008 — the data must be reachable without
 * the SPA).
 */

export interface AdminRouteOptions {
  /** Where backup artifacts live; undefined (e.g. :memory: tests) → 503. */
  backupsDir?: string | undefined;
  /** The boot-time consistency run (E7.S4 AC-2), surfaced to the admin UI. */
  bootConsistency?: ConsistencyCheckResponse | null;
  appVersion?: string;
  now?: () => Date;
}

export function checkConsistency(db: Database.Database, now: () => Date): ConsistencyCheckResponse {
  const at = now();
  const throughMonth = monthOfDate(at.toISOString().slice(0, 10));
  const report = runConsistencyCheck(db, throughMonth);
  return { ...report, throughMonth, ranAt: at.toISOString() };
}

export function registerAdminRoutes(
  app: FastifyInstance,
  db: Database.Database,
  options: AdminRouteOptions = {},
): void {
  const { backupsDir, bootConsistency = null, appVersion = 'unknown', now = () => new Date() } = options;

  // --- Backup (E7.S1 AC-1: manual trigger; the daily job lives in index.ts) --

  app.post('/api/admin/backup', async (_req, reply): Promise<BackupRunResponse> => {
    if (!backupsDir) {
      return reply.code(503).send({ error: 'backups_unavailable' });
    }
    const result = createBackup(db, { backupsDir, appVersion, now });
    const pruned = pruneBackups(backupsDir, DEFAULT_BACKUP_RETENTION);
    return {
      artifact: { name: result.name, sizeBytes: result.sizeBytes, createdAt: result.createdAt },
      pruned,
    };
  });

  app.get('/api/admin/backups', async (_req, reply): Promise<BackupsResponse> => {
    if (!backupsDir) {
      return reply.code(503).send({ error: 'backups_unavailable' });
    }
    return { backups: listBackups(backupsDir) };
  });

  // --- Consistency check (E7.S4 AC-2/AC-3) -----------------------------------

  app.get('/api/admin/consistency', async (): Promise<BootConsistencyResponse> => ({
    boot: bootConsistency,
  }));

  app.post(
    '/api/admin/consistency/run',
    async (): Promise<ConsistencyCheckResponse> => checkConsistency(db, now),
  );

  // --- CSV export (E7.S2, FR-36) — streamed, never buffered ------------------

  const sendCsv = (reply: FastifyReply, filename: string, lines: Generator<string>): void => {
    void reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .send(Readable.from(lines));
  };

  app.get('/api/export/register.csv', async (_req, reply) => {
    sendCsv(reply, 'register.csv', registerCsvLines(db));
    return reply;
  });

  app.get('/api/export/budget.csv', async (_req, reply) => {
    sendCsv(reply, 'budget.csv', budgetCsvLines(db, monthOfDate(now().toISOString().slice(0, 10))));
    return reply;
  });
}
