import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedSystemCategories } from '../../src/db/seed.js';
import { getSetting, setSetting } from '../../src/admin/settings.js';
import { LAST_BACKUP_SETTING_KEY } from '../../src/admin/backup.js';
import { createBackupScheduler, BACKUP_INTERVAL_MS } from '../../src/web/backup-scheduler.js';

/**
 * E7.S1 AC-5 (NFR-7, RPO ≤ 24 h): the in-app daily backup job — same
 * fake-clock discipline as the Plaid scheduler tests, no sleeps.
 */

describe('daily backup scheduler (E7.S1 AC-5)', () => {
  let dir: string;
  let db: Database.Database;
  let backupsDir: string;
  let clock: Date;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ynab-e7-sched-'));
    backupsDir = join(dir, 'backups');
    db = openDatabase(join(dir, 'app.db'));
    runMigrations(db);
    seedSystemCategories(db);
    clock = new Date('2026-06-12T06:00:00Z');
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function scheduler(retention?: number) {
    return createBackupScheduler({
      db,
      backupsDir,
      now: () => clock,
      ...(retention !== undefined ? { retention } : {}),
    });
  }

  it('backs up immediately when no backup has ever run, and stamps the slot', () => {
    const s = scheduler();
    expect(s.tick()).toBe(true);
    expect(readdirSync(backupsDir)).toHaveLength(1);
    expect(getSetting(db, LAST_BACKUP_SETTING_KEY)?.value).toBe(clock.toISOString());
  });

  it('RPO ≤ 24 h: not due again until a day has passed; due exactly at the boundary', () => {
    const s = scheduler();
    s.tick();
    clock = new Date(clock.getTime() + BACKUP_INTERVAL_MS - 1);
    expect(s.tick()).toBe(false);
    expect(readdirSync(backupsDir)).toHaveLength(1);

    clock = new Date(clock.getTime() + 1);
    expect(s.tick()).toBe(true);
    expect(readdirSync(backupsDir)).toHaveLength(2);
  });

  it('an overdue slot after a restart runs once, not once per missed day', () => {
    setSetting(db, LAST_BACKUP_SETTING_KEY, '2026-06-01T00:00:00.000Z'); // 11 days ago
    const s = scheduler();
    expect(s.tick()).toBe(true); // catch-up
    expect(s.tick()).toBe(false); // re-stamped — no stampede
    expect(readdirSync(backupsDir)).toHaveLength(1);
  });

  it('applies keep-N retention on every run', () => {
    const s = scheduler(2);
    for (let day = 0; day < 4; day += 1) {
      s.tick();
      clock = new Date(clock.getTime() + BACKUP_INTERVAL_MS);
    }
    expect(readdirSync(backupsDir)).toHaveLength(2);
  });

  it('start() ticks immediately and stop() cancels the loop (injected timers)', () => {
    const timeouts: { fn: () => void; ms: number }[] = [];
    const s = createBackupScheduler({
      db,
      backupsDir,
      now: () => clock,
      timers: {
        setTimeout: (fn, ms) => {
          timeouts.push({ fn, ms });
          return timeouts.length;
        },
        clearTimeout: () => undefined,
      },
    });
    s.start();
    expect(readdirSync(backupsDir)).toHaveLength(1); // immediate first check
    expect(timeouts).toHaveLength(1); // loop re-armed
    s.stop();
    timeouts[0]!.fn(); // a stray timer after stop() must not re-arm
    expect(timeouts).toHaveLength(1);
  });
});
