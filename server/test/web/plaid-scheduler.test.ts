import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { milliunits } from '@ynab-clone/shared';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedSystemCategories } from '../../src/db/seed.js';
import { loadMasterKey } from '../../src/crypto/index.js';
import { clearPlaidCredentials, setPlaidCredentials } from '../../src/admin/plaid.js';
import { getSetting, setPollingIntervalHours } from '../../src/admin/settings.js';
import { createAccount } from '../../src/ledger/index.js';
import {
  applyAccountMappings,
  createLinkedItem,
  getPlaidItem,
  listSyncLog,
  PlaidApiError,
  syncPlaidItem,
  type PlaidClientPort,
  type PlaidSyncPage,
} from '../../src/importing/index.js';
import {
  createPlaidScheduler,
  LAST_POLL_SETTING_KEY,
  PlaidSyncGate,
  type PlaidScheduler,
} from '../../src/web/plaid-scheduler.js';

/**
 * E5.S3 — the in-process polling scheduler (FR-21, NFR-4, ADR-006), driven
 * entirely with an injected clock and timers: the suite never sleeps and
 * never touches Plaid (fake PlaidClientPort at the factory seam).
 *
 * Pins: due/not-due against the persisted schedule (restart semantics, AC-3),
 * live interval changes (AC-2), ACTIVE-only polling (AC-4), per-item failure
 * isolation, NEEDS_RELINK pausing after ITEM_LOGIN_REQUIRED (S4 handoff),
 * single-flight with a concurrent manual sync (AC-6), and the timer loop.
 */

const masterKey = loadMasterKey({ MASTER_KEY: 'd'.repeat(64) });
const HOUR_MS = 3_600_000;
const T0 = Date.parse('2026-06-12T06:00:00.000Z');

interface ScriptStep {
  page?: PlaidSyncPage;
  error?: Error;
  /** Resolve/reject later — for in-flight overlap tests (AC-6). */
  defer?: Promise<PlaidSyncPage>;
}

function emptyPage(cursor = 'c1'): PlaidSyncPage {
  return { added: [], modified: [], removed: [], nextCursor: cursor, hasMore: false };
}

/** Scripted per-access-token fake; unscripted calls sync an empty page. */
class FakePlaidClient implements PlaidClientPort {
  /** Every transactionsSync call: which Item's token, with which cursor. */
  calls: { token: string; cursor: string | null }[] = [];
  private scripts = new Map<string, ScriptStep[]>();

  queue(token: string, ...steps: ScriptStep[]): void {
    this.scripts.set(token, [...(this.scripts.get(token) ?? []), ...steps]);
  }
  async createLinkToken(): Promise<string> {
    return 'link-token';
  }
  async createUpdateLinkToken(): Promise<string> {
    return 'update-link-token';
  }
  async exchangePublicToken(): Promise<{ accessToken: string; plaidItemId: string }> {
    throw new Error('not used by the scheduler');
  }
  async getItemAccounts(): Promise<{ institutionName: string | null; accounts: [] }> {
    return { institutionName: null, accounts: [] };
  }
  async removeItem(): Promise<void> {
    // not used by the scheduler
  }
  async transactionsSync(token: string, cursor: string | null): Promise<PlaidSyncPage> {
    this.calls.push({ token, cursor });
    const step = this.scripts.get(token)?.shift();
    if (!step) return emptyPage();
    if (step.defer) return step.defer;
    if (step.error) throw step.error;
    return step.page!;
  }
  callsFor(token: string): number {
    return this.calls.filter((c) => c.token === token).length;
  }
}

let db: Database.Database;
let client: FakePlaidClient;
let gate: PlaidSyncGate;
let nowMs: number;
let itemA: string;
let itemB: string;

/** Build a scheduler around the shared db/clock/gate; checkEveryMs irrelevant for tick(). */
function makeScheduler(over: { gate?: PlaidSyncGate } = {}): PlaidScheduler {
  return createPlaidScheduler({
    db,
    masterKey,
    gate: over.gate ?? gate,
    clientFactory: () => client,
    now: () => new Date(nowMs),
  });
}

function linkActiveItem(plaidItemId: string, accessToken: string, accountName: string): string {
  const accountId = createAccount(db, {
    name: accountName,
    type: 'chequing',
    startingBalanceMilliunits: milliunits(0),
    startingDate: '2026-01-01',
  }).id;
  const item = createLinkedItem(db, masterKey, {
    plaidItemId,
    accessToken,
    institutionName: plaidItemId,
    accounts: [
      { plaidAccountId: `pa-${plaidItemId}`, name: accountName, mask: null, type: 'depository', subtype: null },
    ],
  });
  applyAccountMappings(db, item.id, [
    { plaidAccountId: `pa-${plaidItemId}`, accountId, skipped: false },
  ]);
  return item.id;
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  seedSystemCategories(db);
  setPlaidCredentials(db, masterKey, 'client-abc', 'plaid-secret-xyz');
  client = new FakePlaidClient();
  gate = new PlaidSyncGate();
  nowMs = T0;
  itemA = linkActiveItem('item-a', 'tok-a', 'Chequing A');
  itemB = linkActiveItem('item-b', 'tok-b', 'Chequing B');
});
afterEach(() => db.close());

describe('due/not-due against the persisted schedule (AC-1, AC-3)', () => {
  it('first-ever check polls promptly, syncs every ACTIVE Item, and records attempts (AC-5)', async () => {
    const scheduler = makeScheduler();
    expect(await scheduler.tick()).toBe(true);
    expect(client.callsFor('tok-a')).toBe(1);
    expect(client.callsFor('tok-b')).toBe(1);
    // FR-27/AC-5: every poll leaves a per-item attempt in the health log.
    expect(listSyncLog(db, itemA)[0]).toMatchObject({ outcome: 'success' });
    expect(listSyncLog(db, itemB)[0]).toMatchObject({ outcome: 'success' });
    // the slot is claimed (persisted) at the poll's start time
    expect(getSetting(db, LAST_POLL_SETTING_KEY)?.value).toBe(new Date(T0).toISOString());
  });

  it('within the interval nothing runs; at the interval boundary the next poll runs', async () => {
    const scheduler = makeScheduler();
    await scheduler.tick();
    nowMs = T0 + 3 * HOUR_MS;
    expect(await scheduler.tick()).toBe(false);
    expect(client.callsFor('tok-a')).toBe(1);
    nowMs = T0 + 6 * HOUR_MS; // default interval is 6h
    expect(await scheduler.tick()).toBe(true);
    expect(client.callsFor('tok-a')).toBe(2);
  });

  it('AC-3: a restart honours the persisted schedule — not-due waits, overdue polls once with no catch-up burst', async () => {
    await makeScheduler().tick(); // poll at T0, then the "process dies"

    // restart 2h later: not due — no skipped-ahead poll
    nowMs = T0 + 2 * HOUR_MS;
    expect(await makeScheduler().tick()).toBe(false);

    // restart 20h later: overdue — exactly ONE prompt poll, replays none of
    // the missed slots
    nowMs = T0 + 20 * HOUR_MS;
    const restarted = makeScheduler();
    expect(await restarted.tick()).toBe(true);
    expect(await restarted.tick()).toBe(false); // immediately after: not due again
    expect(client.callsFor('tok-a')).toBe(2);
  });
});

describe('interval setting read live (AC-2, FR-34)', () => {
  it('a shortened interval takes effect without restart or redeploy', async () => {
    const scheduler = makeScheduler();
    await scheduler.tick(); // poll at T0; next slot would be T0+6h
    setPollingIntervalHours(db, 1); // settings change, no new scheduler
    nowMs = T0 + 1 * HOUR_MS;
    expect(await scheduler.tick()).toBe(true);
    expect(client.callsFor('tok-a')).toBe(2);
  });

  it('a lengthened interval pushes the next slot out', async () => {
    const scheduler = makeScheduler();
    await scheduler.tick();
    setPollingIntervalHours(db, 24);
    nowMs = T0 + 6 * HOUR_MS;
    expect(await scheduler.tick()).toBe(false);
    nowMs = T0 + 24 * HOUR_MS;
    expect(await scheduler.tick()).toBe(true);
  });
});

describe('which Items poll (AC-4)', () => {
  it('skips NEEDS_RELINK, UNLINKED and LINKING Items — only ACTIVE syncs', async () => {
    db.prepare("UPDATE plaid_items SET status = 'NEEDS_RELINK' WHERE id = ?").run(itemA);
    const itemC = linkActiveItem('item-c', 'tok-c', 'Chequing C');
    db.prepare("UPDATE plaid_items SET status = 'UNLINKED' WHERE id = ?").run(itemC);
    linkActiveItem('item-d', 'tok-d', 'Chequing D');
    db.prepare("UPDATE plaid_items SET status = 'LINKING' WHERE plaid_item_id = 'item-d'").run();

    await makeScheduler().tick();
    expect(client.calls.map((c) => c.token)).toEqual(['tok-b']);
  });

  it('Plaid not configured: the slot is claimed quietly, no sync attempted', async () => {
    clearPlaidCredentials(db);
    expect(await makeScheduler().tick()).toBe(true);
    expect(client.calls).toEqual([]);
  });
});

describe('failure isolation and the S4 handoff', () => {
  it('one Item failing does not stop the others, and the failure is in its health log', async () => {
    client.queue('tok-a', { error: new PlaidApiError('INTERNAL_SERVER_ERROR', 'plaid hiccup') });
    await makeScheduler().tick();
    expect(client.callsFor('tok-b')).toBe(1);
    expect(listSyncLog(db, itemA)[0]).toMatchObject({
      outcome: 'error',
      errorCode: 'INTERNAL_SERVER_ERROR',
    });
    // a non-auth failure does NOT flip the state machine (S4 AC-4)
    expect(getPlaidItem(db, itemA).status).toBe('ACTIVE');
    expect(listSyncLog(db, itemB)[0]).toMatchObject({ outcome: 'success' });
  });

  it('ITEM_LOGIN_REQUIRED flips the Item to NEEDS_RELINK and the next poll skips it (S4 AC-1)', async () => {
    client.queue('tok-a', { error: new PlaidApiError('ITEM_LOGIN_REQUIRED', 'relink please') });
    const scheduler = makeScheduler();
    await scheduler.tick();
    expect(getPlaidItem(db, itemA).status).toBe('NEEDS_RELINK');

    nowMs = T0 + 6 * HOUR_MS;
    await scheduler.tick();
    expect(client.callsFor('tok-a')).toBe(1); // paused — never retried
    expect(client.callsFor('tok-b')).toBe(2);
  });
});

describe('single-flight per Item (AC-6)', () => {
  it('a scheduled poll joins an in-flight manual sync instead of double-running the Item', async () => {
    let release!: (page: PlaidSyncPage) => void;
    client.queue('tok-a', {
      defer: new Promise<PlaidSyncPage>((resolve) => {
        release = resolve;
      }),
    });

    // manual "sync now" through the SAME gate the routes use, still in flight…
    const manual = gate.run(itemA, () => syncPlaidItem(db, masterKey, client, itemA));
    // …when the scheduled poll fires
    const poll = makeScheduler().tick();
    release(emptyPage());
    await Promise.all([manual, poll]);

    expect(client.callsFor('tok-a')).toBe(1); // ONE run, not two
    expect(client.callsFor('tok-b')).toBe(1); // the other Item still polled
    expect(listSyncLog(db, itemA)).toHaveLength(1);
  });
});

describe('the check loop (start/stop, injected timers)', () => {
  it('start() checks immediately, reschedules every checkEveryMs, and stop() cancels', async () => {
    const scheduled: { fn: () => void; ms: number }[] = [];
    let cleared = 0;
    const scheduler = createPlaidScheduler({
      db,
      masterKey,
      gate,
      clientFactory: () => client,
      now: () => new Date(nowMs),
      checkEveryMs: 60_000,
      timers: {
        setTimeout: (fn, ms) => {
          scheduled.push({ fn, ms });
          return scheduled.length;
        },
        clearTimeout: () => {
          cleared += 1;
        },
      },
    });

    scheduler.start();
    await new Promise((resolve) => setImmediate(resolve)); // let the first tick settle
    expect(client.callsFor('tok-a')).toBe(1); // boot check polled promptly
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.ms).toBe(60_000);

    scheduled[0]!.fn(); // the next check fires: not due — no extra sync
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.callsFor('tok-a')).toBe(1);
    expect(scheduled).toHaveLength(2); // loop rescheduled itself

    scheduler.stop();
    expect(cleared).toBe(1);
    scheduled[1]!.fn(); // a late timer after stop() must not reschedule
    await new Promise((resolve) => setImmediate(resolve));
    expect(scheduled).toHaveLength(2);
  });
});
