import type Database from 'better-sqlite3';
import { getPollingIntervalHours, getSetting, setSetting } from '../admin/settings.js';
import { getPlaidCredentialsStatus, getPlaidEnvironment, getPlaidSecret } from '../admin/plaid.js';
import {
  createPlaidSdkClient,
  listPlaidItems,
  syncPlaidItem,
  type PlaidClientFactory,
  type PlaidClientPort,
  type PlaidSyncResult,
} from '../importing/index.js';

/**
 * In-process polling scheduler (E5.S3, FR-21, NFR-4, ADR-006): a timer inside
 * the app server — no cron container, no queue, no inbound URL. It lives in
 * the web/composition layer because it is pure wiring: credentials and the
 * polling interval come from admin/, the sync job from importing/ (which may
 * import neither admin nor web, per ADR-001).
 *
 * Schedule persistence (AC-3): `plaid_sync_last_poll_at` in the settings
 * table. The next slot is DERIVED — last poll + the CURRENT interval setting,
 * read live on every check — so a changed interval takes effect immediately
 * without restart (AC-2/FR-34) and a restart neither skips a slot (an overdue
 * poll runs at the first check) nor stampedes (the persisted timestamp means
 * at most one catch-up poll; running re-stamps it). ADR-006 speaks of a
 * persisted `next_run_at`; persisting the LAST run and deriving the next is
 * the same contract with live-interval semantics.
 *
 * The check loop wakes every `checkEveryMs` (default 1 min — well inside
 * NFR-4's poll-within-10-minutes-of-slot window) and polls only when due.
 * Clock and timers are injectable; the test suite drives `tick()` with a
 * fake clock and never sleeps.
 */

export const LAST_POLL_SETTING_KEY = 'plaid_sync_last_poll_at';
export const DEFAULT_CHECK_EVERY_MS = 60_000;
const MS_PER_HOUR = 3_600_000;

/**
 * Per-Item single-flight gate (S3 AC-6): a manual "sync now" and a scheduled
 * poll can never run the same Item concurrently — the second caller joins the
 * in-flight run and gets its result. One gate instance is shared between the
 * HTTP routes and the scheduler (wired in index.ts / buildApp).
 */
export class PlaidSyncGate {
  private readonly inFlight = new Map<string, Promise<PlaidSyncResult>>();

  run(itemId: string, job: () => Promise<PlaidSyncResult>): Promise<PlaidSyncResult> {
    const existing = this.inFlight.get(itemId);
    if (existing) return existing;
    const running = job().finally(() => this.inFlight.delete(itemId));
    this.inFlight.set(itemId, running);
    return running;
  }
}

interface SchedulerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface PlaidSchedulerOptions {
  db: Database.Database;
  masterKey: Buffer;
  /** Shared with the manual-sync route so runs never overlap per Item (AC-6). */
  gate: PlaidSyncGate;
  /** Injectable client seam (ADR-006): tests pass a fake factory. */
  clientFactory?: PlaidClientFactory;
  env?: Record<string, string | undefined>;
  /** Injectable clock (codebase idiom — see buildApp's `now`). */
  now?: () => Date;
  /** How often the loop CHECKS whether a poll is due. */
  checkEveryMs?: number;
  /** Injectable timer functions for tests (no sleeps in the suite). */
  timers?: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  logger?: SchedulerLogger;
}

export interface PlaidScheduler {
  /** Begin the check loop (server boot only — never in tests/buildApp). */
  start(): void;
  stop(): void;
  /**
   * One due-check: polls every ACTIVE Item when the slot has arrived.
   * Exposed so tests drive the schedule with a fake clock. Returns whether a
   * poll ran.
   */
  tick(): Promise<boolean>;
}

const NULL_LOGGER: SchedulerLogger = { info: () => undefined, warn: () => undefined };

export function createPlaidScheduler({
  db,
  masterKey,
  gate,
  clientFactory = createPlaidSdkClient,
  env = process.env,
  now = () => new Date(),
  checkEveryMs = DEFAULT_CHECK_EVERY_MS,
  timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) },
  logger = NULL_LOGGER,
}: PlaidSchedulerOptions): PlaidScheduler {
  let running = false;
  let timer: unknown = null;

  /** Stored credentials → client, or null when Plaid is not configured yet. */
  const tryClient = (): PlaidClientPort | null => {
    const status = getPlaidCredentialsStatus(db);
    const secret = status.configured ? getPlaidSecret(db, masterKey) : undefined;
    if (!status.configured || status.clientId === null || secret === undefined) return null;
    return clientFactory({
      clientId: status.clientId,
      secret,
      environment: getPlaidEnvironment(db, env),
    });
  };

  const tick = async (): Promise<boolean> => {
    // Interval read LIVE on every check — a settings change needs no restart
    // (AC-2, FR-34's verified-by).
    const intervalMs = getPollingIntervalHours(db) * MS_PER_HOUR;
    const lastPollAt = getSetting(db, LAST_POLL_SETTING_KEY)?.value ?? null;
    const nowMs = now().getTime();
    if (lastPollAt !== null && nowMs < Date.parse(lastPollAt) + intervalMs) return false;

    // Claim the slot BEFORE syncing: a crash mid-poll costs at most one
    // delayed poll (ADR-006), never a restart stampede (AC-3).
    setSetting(db, LAST_POLL_SETTING_KEY, new Date(nowMs).toISOString());

    const client = tryClient();
    if (client === null) {
      logger.warn({}, 'plaid poll skipped: credentials not configured');
      return true;
    }

    for (const item of listPlaidItems(db)) {
      // AC-4: only ACTIVE Items poll — NEEDS_RELINK pauses (S4), UNLINKED is
      // terminal (S5), LINKING has no mappings yet.
      if (item.status !== 'ACTIVE') continue;
      try {
        const result = await gate.run(item.id, () => syncPlaidItem(db, masterKey, client, item.id));
        logger.info(
          { itemId: item.id, added: result.addedCount, updated: result.updatedCount },
          'plaid poll synced item',
        );
      } catch (err) {
        // Per-item isolation: one broken Item never blocks the others. The
        // failure is already in plaid_sync_log (S2 AC-7), and an
        // ITEM_LOGIN_REQUIRED has already flipped it to NEEDS_RELINK (S4).
        logger.warn(
          { itemId: item.id, err: err instanceof Error ? err.message : String(err) },
          'plaid poll failed for item',
        );
      }
    }
    return true;
  };

  const loop = (): void => {
    void tick()
      .catch((err: unknown) => {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'plaid poll tick failed');
      })
      .finally(() => {
        if (running) timer = timers.setTimeout(loop, checkEveryMs);
      });
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      // First check runs immediately: an overdue slot after a restart polls
      // promptly (AC-3) — once, because tick() re-stamps the schedule.
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
