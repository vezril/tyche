import type Database from 'better-sqlite3';
import type { ConsistencyCheckResponse } from '@ynab-clone/shared';
import { createBackup, type BackupResult } from '../admin/backup.js';
import { computeBalanceChecksum } from '../admin/checksum.js';
import { listPendingMigrations, MIGRATIONS_DIR, runMigrations } from '../db/migrate.js';
import { seedSystemCategories } from '../db/seed.js';
import { checkConsistency } from './admin-routes.js';

/**
 * The boot sequence's data half (architecture §8, E7.S3/S4), extracted from
 * index.ts so the upgrade bracket is testable:
 *
 *   1. pending migrations + existing ledger? → pre-migration auto-backup and
 *      a balance checksum recorded BEFORE (NFR-11, ADR-003);
 *   2. run forward-only migrations;
 *   3. verify the checksum AFTER — any difference means a migration silently
 *      altered historical balances → THROW, the caller refuses to serve;
 *   4. seed system categories;
 *   5. NFR-12 consistency check (E7.S4 AC-2) — a mismatch is a loud warning
 *      state (returned for logging + the admin banner), not a refusal: the
 *      data is readable and the user must be able to see the report.
 */

export const PRE_MIGRATION_BACKUP_PREFIX = 'ynab-clone-pre-migration-';

interface BootLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface StartupOptions {
  db: Database.Database;
  /** Pre-migration auto-backups land here; omit (tests, :memory:) to skip them. */
  backupsDir?: string | undefined;
  migrationsDir?: string;
  appVersion?: string;
  now?: () => Date;
  logger?: BootLogger;
}

export interface StartupResult {
  appliedMigrations: string[];
  /** The automatic safety backup taken before pending migrations, if any ran. */
  preMigrationBackup: BackupResult | null;
  /** The boot-time NFR-12 check — pass to the admin routes (E7.S4 AC-2). */
  consistency: ConsistencyCheckResponse;
}

const NULL_LOGGER: BootLogger = { info: () => undefined, error: () => undefined };

export function runStartupSequence({
  db,
  backupsDir,
  migrationsDir = MIGRATIONS_DIR,
  appVersion = 'unknown',
  now = () => new Date(),
  logger = NULL_LOGGER,
}: StartupOptions): StartupResult {
  const pending = listPendingMigrations(db, migrationsDir);

  // The NFR-11 bracket arms only when there is existing data to protect.
  const checksumBefore = pending.length > 0 ? computeBalanceChecksum(db) : null;
  let preMigrationBackup: BackupResult | null = null;
  if (checksumBefore !== null && backupsDir) {
    preMigrationBackup = createBackup(db, {
      backupsDir,
      appVersion,
      now,
      prefix: PRE_MIGRATION_BACKUP_PREFIX,
    });
    logger.info({ artifact: preMigrationBackup.name }, 'pre-migration backup written (NFR-11)');
  }

  const appliedMigrations = runMigrations(db, migrationsDir);

  if (checksumBefore !== null) {
    const checksumAfter = computeBalanceChecksum(db);
    if (checksumAfter !== checksumBefore) {
      logger.error(
        { before: checksumBefore, after: checksumAfter, applied: appliedMigrations },
        'migration altered historical balances — REFUSING to serve (NFR-11)',
      );
      throw new Error(
        `migration balance checksum mismatch: a migration altered historical balances (NFR-11). ` +
          `The pre-migration backup is ${preMigrationBackup ? preMigrationBackup.name : 'in data/backups/'} — restore it and report the bug.`,
      );
    }
  }

  seedSystemCategories(db);

  const consistency = checkConsistency(db, now);
  if (consistency.ok) {
    logger.info(
      { checkedAccounts: consistency.checkedAccounts, checkedMonths: consistency.checkedMonths },
      'NFR-12 consistency check passed at boot',
    );
  } else {
    logger.error(
      { mismatches: consistency.mismatches },
      'NFR-12 consistency check FAILED at boot — money math may have drifted; see the Ops screen',
    );
  }

  return { appliedMigrations, preMigrationBackup, consistency };
}
