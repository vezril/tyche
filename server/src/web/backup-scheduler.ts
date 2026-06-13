import type Database from 'better-sqlite3';
import { getSetting, setSetting } from '../admin/settings.js';
import {
  createBackup,
  DEFAULT_BACKUP_RETENTION,
  LAST_BACKUP_SETTING_KEY,
  pruneBackups,
} from '../admin/backup.js';

/**
 * Daily backup scheduler (E7.S1 AC-5, NFR-7 RPO ≤ 24 h): the same in-process
 * timer-loop shape as the Plaid polling scheduler (E5.S3 / ADR-006) — persist
 * the LAST run, derive the next, claim the slot before working so a restart
 * neither skips a day nor stampedes. Retention keeps the newest N scheduled
 * artifacts (pre-migration safety backups are never reaped — see
 * pruneBackups). Off-host copies remain Calvin's job (OQ-7).
 */

export const BACKUP_INTERVAL_MS = 86_400_000; // 24 h
export const DEFAULT_BACKUP_CHECK_EVERY_MS = 300_000; // worst case +5 min on the RPO

interface SchedulerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

const NULL_LOGGER: SchedulerLogger = { info: () => undefined, warn: () => undefined };

export interface BackupSchedulerOptions {
  db: Database.Database;
  backupsDir: string;
  appVersion?: string;
  retention?: number;
  now?: () => Date;
  checkEveryMs?: number;
  /** Injectable timers — the test suite never sleeps (E5.S3 idiom). */
  timers?: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  logger?: SchedulerLogger;
}

export interface BackupScheduler {
  start(): void;
  stop(): void;
  /** One due-check; returns whether a backup ran. Exposed for fake-clock tests. */
  tick(): boolean;
}

export function createBackupScheduler({
  db,
  backupsDir,
  appVersion = 'unknown',
  retention = DEFAULT_BACKUP_RETENTION,
  now = () => new Date(),
  checkEveryMs = DEFAULT_BACKUP_CHECK_EVERY_MS,
  timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) },
  logger = NULL_LOGGER,
}: BackupSchedulerOptions): BackupScheduler {
  let running = false;
  let timer: unknown = null;

  const tick = (): boolean => {
    const lastRunAt = getSetting(db, LAST_BACKUP_SETTING_KEY)?.value ?? null;
    const nowMs = now().getTime();
    if (lastRunAt !== null && nowMs < Date.parse(lastRunAt) + BACKUP_INTERVAL_MS) return false;

    // Claim the slot first (E5.S3 idiom): a crash mid-backup costs one delayed
    // artifact, never a restart stampede.
    setSetting(db, LAST_BACKUP_SETTING_KEY, new Date(nowMs).toISOString());
    const result = createBackup(db, { backupsDir, appVersion, now });
    const pruned = pruneBackups(backupsDir, retention);
    logger.info({ artifact: result.name, pruned }, 'daily backup written');
    return true;
  };

  const loop = (): void => {
    try {
      tick();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'daily backup failed');
    } finally {
      if (running) timer = timers.setTimeout(loop, checkEveryMs);
    }
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      // First check immediately: an overdue slot after a restart backs up now.
      loop();
    },
    stop(): void {
      running = false;
      if (timer !== null) {
        timers.clearTimeout(timer);
        timer = null;
      }
    },
    tick,
  };
}
