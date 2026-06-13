import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { milliunits } from '@ynab-clone/shared';
import { openDatabase } from '../../src/db/connection.js';
import { MIGRATIONS_DIR, runMigrations } from '../../src/db/migrate.js';
import { seedSystemCategories, INFLOW_READY_TO_ASSIGN_CATEGORY_ID } from '../../src/db/seed.js';
import { createAccount, createTransaction } from '../../src/ledger/index.js';
import { runStartupSequence, PRE_MIGRATION_BACKUP_PREFIX } from '../../src/web/boot.js';

/**
 * E7.S3 AC-3 (NFR-11, ADR-003): the upgrade bracket — pending migrations on
 * existing data take an automatic pre-migration backup and a balance checksum
 * before, verified after; a migration that silently alters historical
 * balances ABORTS the boot. E7.S4 AC-2: the boot consistency check runs in
 * the same sequence and reports loudly.
 */

describe('startup sequence: migrate bracket + consistency (E7.S3/S4)', () => {
  let dir: string;
  let db: Database.Database;
  let backupsDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ynab-e7-boot-'));
    backupsDir = join(dir, 'backups');
    db = openDatabase(join(dir, 'app.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seedLedger(): void {
    seedSystemCategories(db);
    db.prepare("INSERT INTO category_groups (id, name, sort_order) VALUES ('g1', 'Everyday', 1)").run();
    db.prepare("INSERT INTO categories (id, group_id, name) VALUES ('groceries', 'g1', 'Groceries')").run();
    const account = createAccount(db, {
      name: 'Chequing',
      type: 'chequing',
      startingBalanceMilliunits: milliunits(250_000),
      startingDate: '2026-01-01',
    });
    createTransaction(db, {
      accountId: account.id,
      date: '2026-02-01',
      amountMilliunits: milliunits(900_000),
      payeeName: 'Employer',
      categoryId: INFLOW_READY_TO_ASSIGN_CATEGORY_ID,
      memo: '',
    });
  }

  /** A migrations dir = the real ones + one extra "next version" file. */
  function migrationsPlus(extraName: string, sql: string): string {
    const fakeDir = join(dir, 'migrations');
    cpSync(MIGRATIONS_DIR, fakeDir, { recursive: true });
    writeFileSync(join(fakeDir, extraName), sql);
    return fakeDir;
  }

  it('fresh database: applies all migrations, takes NO pre-migration backup, consistency passes', () => {
    const result = runStartupSequence({ db, backupsDir });
    expect(result.appliedMigrations.length).toBeGreaterThanOrEqual(8);
    expect(result.preMigrationBackup).toBeNull(); // nothing to protect yet
    expect(result.consistency.ok).toBe(true);
  });

  it('no pending migrations: idempotent, no backup, consistency still reported', () => {
    runMigrations(db);
    seedLedger();
    const result = runStartupSequence({ db, backupsDir });
    expect(result.appliedMigrations).toEqual([]);
    expect(result.preMigrationBackup).toBeNull();
    expect(result.consistency.ok).toBe(true);
    expect(result.consistency.checkedAccounts).toBe(1);
  });

  it('AC-3: a benign pending migration on existing data → auto pre-migration backup, checksum verifies, boot proceeds', () => {
    runMigrations(db);
    seedLedger();
    const fakeDir = migrationsPlus('0009_benign.sql', 'CREATE TABLE new_feature (id TEXT PRIMARY KEY) STRICT;');

    const result = runStartupSequence({ db, backupsDir, migrationsDir: fakeDir });
    expect(result.appliedMigrations).toEqual(['0009_benign.sql']);
    expect(result.preMigrationBackup).not.toBeNull();
    expect(result.preMigrationBackup!.name.startsWith(PRE_MIGRATION_BACKUP_PREFIX)).toBe(true);
    expect(readdirSync(backupsDir)).toEqual([result.preMigrationBackup!.name]);
    expect(result.consistency.ok).toBe(true);
  });

  it('AC-3 (the teeth): a migration that alters historical balances ABORTS loudly', () => {
    runMigrations(db);
    seedLedger();
    const fakeDir = migrationsPlus(
      '0009_evil.sql',
      'UPDATE transactions SET amount_milliunits = amount_milliunits + 1000;',
    );

    expect(() => runStartupSequence({ db, backupsDir, migrationsDir: fakeDir })).toThrow(
      /balance checksum mismatch/,
    );
    // …and the way back exists: the automatic pre-migration backup is on disk.
    const artifacts = readdirSync(backupsDir);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.startsWith(PRE_MIGRATION_BACKUP_PREFIX)).toBe(true);
  });

  it('S4 AC-2: boot consistency failure is a warning state, NOT a refusal to start', () => {
    runMigrations(db);
    seedLedger();
    // Corrupt a raw row the way only the FR-15 invariant can see.
    const parent = db
      .prepare('SELECT id, account_id AS accountId FROM transactions WHERE amount_milliunits = 900000')
      .get() as { id: string; accountId: string };
    db.prepare(
      `INSERT INTO transactions (id, account_id, date, amount_milliunits, category_id, parent_id, memo)
       VALUES ('bad-line', ?, '2026-02-01', -1000, 'groceries', ?, '')`,
    ).run(parent.accountId, parent.id);

    const errors: string[] = [];
    const result = runStartupSequence({
      db,
      backupsDir,
      logger: { info: () => undefined, error: (_obj, msg) => errors.push(msg) },
    });
    expect(result.consistency.ok).toBe(false); // surfaced to the admin banner
    expect(errors.join('\n')).toContain('NFR-12 consistency check FAILED');
  });
});
