import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { milliunits } from '@ynab-clone/shared';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedSystemCategories, INFLOW_READY_TO_ASSIGN_CATEGORY_ID } from '../../src/db/seed.js';
import { createAccount, createTransaction, accountBalances } from '../../src/ledger/index.js';
import { setAssignedAmount, runConsistencyCheck } from '../../src/budget/index.js';
import { computeBudget } from '../../src/budget/engine.js';
import { loadEngineInputs } from '../../src/budget/queries.js';
import { encryptField, decryptField, loadMasterKey } from '../../src/crypto/index.js';
import { setPlaidCredentials, getPlaidSecret } from '../../src/admin/plaid.js';
import {
  createBackup,
  listBackups,
  pruneBackups,
  restoreBackup,
  BACKUP_PREFIX,
  MANIFEST_FILE_NAME,
  SNAPSHOT_FILE_NAME,
  type BackupManifest,
} from '../../src/admin/backup.js';

/**
 * E7.S1 (FR-35, NFR-7, ADR-003/ADR-007): one backup artifact, one-command
 * restore, ciphertext-only contents. The round-trip test below IS the FR-35
 * Verified-by, automated: seed → backup → restore into a fresh location →
 * scripted comparison of balances, RTA, and transaction counts.
 */

const MASTER_KEY = loadMasterKey({
  MASTER_KEY: 'a'.repeat(64),
});
const OTHER_KEY = loadMasterKey({
  MASTER_KEY: 'b'.repeat(64),
});
const PLAID_SECRET_PLAINTEXT = 'plaid-secret-sandbox-9f8e7d6c';
const ACCESS_TOKEN_PLAINTEXT = 'access-sandbox-1a2b3c4d5e6f';

describe('backup & restore (E7.S1)', () => {
  let dir: string;
  let db: Database.Database;
  let backupsDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ynab-e7-backup-'));
    backupsDir = join(dir, 'backups');
    db = openDatabase(join(dir, 'app.db'));
    runMigrations(db);
    seedSystemCategories(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Realistic dataset: income, spending, split, transfer, plaid secrets. */
  function seedData(): { chequingId: string; savingsId: string } {
    db.prepare("INSERT INTO category_groups (id, name, sort_order) VALUES ('g1', 'Everyday', 1)").run();
    db.prepare("INSERT INTO categories (id, group_id, name) VALUES ('groceries', 'g1', 'Groceries')").run();
    db.prepare("INSERT INTO categories (id, group_id, name) VALUES ('dining', 'g1', 'Dining')").run();

    const chequing = createAccount(db, {
      name: 'Chequing',
      type: 'chequing',
      startingBalanceMilliunits: milliunits(500_000),
      startingDate: '2026-01-01',
    });
    const savings = createAccount(db, {
      name: 'Savings',
      type: 'savings',
      startingBalanceMilliunits: milliunits(1_000_000),
      startingDate: '2026-01-01',
    });
    createTransaction(db, {
      accountId: chequing.id,
      date: '2026-02-01',
      amountMilliunits: milliunits(2_000_000),
      payeeName: 'Employer',
      categoryId: INFLOW_READY_TO_ASSIGN_CATEGORY_ID,
      memo: '',
    });
    createTransaction(db, {
      accountId: chequing.id,
      date: '2026-02-05',
      amountMilliunits: milliunits(-120_000),
      payeeName: 'Costco',
      categoryId: null,
      memo: 'split',
      splits: [
        { categoryId: 'groceries', amountMilliunits: milliunits(-80_000), memo: '' },
        { categoryId: 'dining', amountMilliunits: milliunits(-40_000), memo: '' },
      ],
    });
    createTransaction(db, {
      accountId: chequing.id,
      date: '2026-02-10',
      amountMilliunits: milliunits(-250_000),
      payeeName: null,
      categoryId: null,
      memo: 'to savings',
      transferAccountId: savings.id,
    });
    setAssignedAmount(db, 'groceries', '2026-02', milliunits(150_000));

    setPlaidCredentials(db, MASTER_KEY, 'client-id-123', PLAID_SECRET_PLAINTEXT);
    db.prepare(
      `INSERT INTO plaid_items (id, plaid_item_id, institution_name, access_token_ciphertext, status)
       VALUES ('item-1', 'plaid-item-1', 'RBC', ?, 'ACTIVE')`,
    ).run(encryptField(MASTER_KEY, ACCESS_TOKEN_PLAINTEXT));
    db.prepare("INSERT INTO settings (key, value) VALUES ('polling_interval_hours', '6')").run();
    return { chequingId: chequing.id, savingsId: savings.id };
  }

  it('AC-1: produces ONE timestamped .tar.gz containing the DB snapshot and a manifest', () => {
    seedData();
    const result = createBackup(db, { backupsDir, appVersion: '0.1.0' });
    expect(result.name).toMatch(/^ynab-clone-backup-\d{8}T\d{6}Z\.tar\.gz$/);
    expect(readdirSync(backupsDir)).toEqual([result.name]);

    const listing = execFileSync('tar', ['-tzf', result.artifactPath]).toString().trim().split('\n').sort();
    expect(listing).toEqual([SNAPSHOT_FILE_NAME, MANIFEST_FILE_NAME].sort());

    expect(result.manifest.format).toBe('ynab-clone-backup/1');
    expect(result.manifest.appVersion).toBe('0.1.0');
    expect(result.manifest.masterKeyIncluded).toBe(false);
    expect(result.manifest.schemaMigrations).toContain('0001_init.sql');
    expect(result.manifest.counts.accounts).toBe(2);
    expect(result.manifest.settings['polling_interval_hours']).toBe('6');
  });

  it('snapshot is taken online (VACUUM INTO) and passes integrity on its own', () => {
    seedData();
    const result = createBackup(db, { backupsDir });
    const extract = mkdtempSync(join(tmpdir(), 'ynab-extract-'));
    try {
      execFileSync('tar', ['-xzf', result.artifactPath, '-C', extract]);
      const snapshot = new Database(join(extract, SNAPSHOT_FILE_NAME), { readonly: true });
      const integrity = snapshot.pragma('integrity_check') as { integrity_check: string }[];
      expect(integrity[0]?.integrity_check).toBe('ok');
      const count = snapshot.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number };
      expect(count.n).toBeGreaterThan(0);
      snapshot.close();
    } finally {
      rmSync(extract, { recursive: true, force: true });
    }
  });

  it('AC-4 (NFR-3): no plaintext Plaid secret or access token anywhere in the artifact', () => {
    seedData();
    const result = createBackup(db, { backupsDir });
    const extract = mkdtempSync(join(tmpdir(), 'ynab-extract-'));
    try {
      execFileSync('tar', ['-xzf', result.artifactPath, '-C', extract]);
      // Raw bytes of the compressed artifact AND every extracted file.
      const blobs = [
        readFileSync(result.artifactPath),
        readFileSync(join(extract, SNAPSHOT_FILE_NAME)),
        readFileSync(join(extract, MANIFEST_FILE_NAME)),
      ];
      for (const blob of blobs) {
        expect(blob.includes(PLAID_SECRET_PLAINTEXT)).toBe(false);
        expect(blob.includes(ACCESS_TOKEN_PLAINTEXT)).toBe(false);
        expect(blob.includes(MASTER_KEY.toString('hex'))).toBe(false);
      }
      // …while the ciphertext envelopes ARE there (the data did travel).
      const snapshot = new Database(join(extract, SNAPSHOT_FILE_NAME), { readonly: true });
      const item = snapshot
        .prepare("SELECT access_token_ciphertext AS ct FROM plaid_items WHERE id = 'item-1'")
        .get() as { ct: string };
      expect(decryptField(MASTER_KEY, item.ct)).toBe(ACCESS_TOKEN_PLAINTEXT);
      snapshot.close();
    } finally {
      rmSync(extract, { recursive: true, force: true });
    }
  });

  it('AC-2 (FR-35 Verified-by): restore on "host B" reproduces balances, RTA, and counts; same key reads secrets', () => {
    const { chequingId, savingsId } = seedData();
    const before = {
      chequing: accountBalances(db, chequingId),
      savings: accountBalances(db, savingsId),
      count: (db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n,
      rta: computeBudget(loadEngineInputs(db), '2026-02').get('2026-02')!.rtaMilliunits,
    };
    const artifact = createBackup(db, { backupsDir });

    // "Host B": a completely fresh location, same .env (MASTER_KEY).
    const hostB = mkdtempSync(join(tmpdir(), 'ynab-host-b-'));
    try {
      const restoredPath = join(hostB, 'data', 'app.db');
      restoreBackup(artifact.artifactPath, restoredPath);
      const restored = openDatabase(restoredPath);
      expect(runMigrations(restored)).toEqual([]); // same schema → boot migrations no-op

      const after = {
        chequing: accountBalances(restored, chequingId),
        savings: accountBalances(restored, savingsId),
        count: (restored.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n,
        rta: computeBudget(loadEngineInputs(restored), '2026-02').get('2026-02')!.rtaMilliunits,
      };
      expect(after).toEqual(before); // identical balances, RTA, transaction counts

      // NFR-12 holds on the restored data, and the same MASTER_KEY still reads
      // the Plaid secrets → syncing resumes without re-link.
      expect(runConsistencyCheck(restored, '2026-06').ok).toBe(true);
      expect(getPlaidSecret(restored, MASTER_KEY)).toBe(PLAID_SECRET_PLAINTEXT);
      const item = restored
        .prepare("SELECT access_token_ciphertext AS ct, status FROM plaid_items WHERE id = 'item-1'")
        .get() as { ct: string; status: string };
      expect(decryptField(MASTER_KEY, item.ct)).toBe(ACCESS_TOKEN_PLAINTEXT);
      expect(item.status).toBe('ACTIVE');
      restored.close();
    } finally {
      rmSync(hostB, { recursive: true, force: true });
    }
  });

  it('AC-3 (ADR-007 consequence): restore WITHOUT the original key keeps all app data; only secrets are unreadable', () => {
    const { chequingId } = seedData();
    const before = accountBalances(db, chequingId);
    const artifact = createBackup(db, { backupsDir });

    const hostB = mkdtempSync(join(tmpdir(), 'ynab-host-b-'));
    try {
      const restoredPath = join(hostB, 'app.db');
      restoreBackup(artifact.artifactPath, restoredPath);
      const restored = openDatabase(restoredPath);

      // Transactions, budget state, settings: fully intact.
      expect(accountBalances(restored, chequingId)).toEqual(before);
      expect(runConsistencyCheck(restored, '2026-06').ok).toBe(true);

      // The lost-key consequence is precisely scoped: ciphertext unreadable.
      expect(() => getPlaidSecret(restored, OTHER_KEY)).toThrow(/key id/);
      const item = restored
        .prepare("SELECT access_token_ciphertext AS ct FROM plaid_items WHERE id = 'item-1'")
        .get() as { ct: string };
      expect(() => decryptField(OTHER_KEY, item.ct)).toThrow(/key id/);
      restored.close();
    } finally {
      rmSync(hostB, { recursive: true, force: true });
    }
  });

  it('restore keeps the previous database aside and clears stale WAL/SHM', () => {
    seedData();
    const artifact = createBackup(db, { backupsDir });
    const targetDir = mkdtempSync(join(tmpdir(), 'ynab-target-'));
    try {
      const targetPath = join(targetDir, 'app.db');
      // An existing (different) database + stale WAL at the target.
      const old = openDatabase(targetPath);
      runMigrations(old);
      old.close();
      writeFileSync(`${targetPath}-wal`, 'stale');
      const result = restoreBackup(artifact.artifactPath, targetPath);
      expect(result.replacedDatabasePath).toMatch(/app\.db\.replaced-/);
      expect(readdirSync(targetDir).some((f) => f.endsWith('-wal'))).toBe(false);
      const restored = new Database(targetPath, { readonly: true });
      expect((restored.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n).toBe(2);
      restored.close();
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it('refuses a corrupt artifact (better no restore than a bad one)', () => {
    seedData();
    const artifact = createBackup(db, { backupsDir });
    const corrupt = join(dir, 'corrupt.tar.gz');
    writeFileSync(corrupt, readFileSync(artifact.artifactPath).subarray(0, 100));
    expect(() => restoreBackup(corrupt, join(dir, 'out.db'))).toThrow();
    expect(() => restoreBackup(join(dir, 'missing.tar.gz'), join(dir, 'out.db'))).toThrow(/not found/);
  });

  it('AC-5: keep-N retention prunes oldest scheduled artifacts only', () => {
    seedData();
    const stamps = ['2026-06-01T01:00:00Z', '2026-06-02T01:00:00Z', '2026-06-03T01:00:00Z'];
    for (const at of stamps) {
      createBackup(db, { backupsDir, now: () => new Date(at) });
    }
    // A pre-migration safety backup and a hand-copied file are never reaped.
    createBackup(db, { backupsDir, now: () => new Date('2026-05-01T01:00:00Z'), prefix: 'ynab-clone-pre-migration-' });
    writeFileSync(join(backupsDir, 'manual-copy.tar.gz'), 'x');

    const pruned = pruneBackups(backupsDir, 2);
    expect(pruned).toEqual([`${BACKUP_PREFIX}20260601T010000Z.tar.gz`]);
    const remaining = readdirSync(backupsDir).sort();
    expect(remaining).toContain('manual-copy.tar.gz');
    expect(remaining).toContain('ynab-clone-pre-migration-20260501T010000Z.tar.gz');
    expect(remaining).toContain(`${BACKUP_PREFIX}20260602T010000Z.tar.gz`);
    expect(remaining).toContain(`${BACKUP_PREFIX}20260603T010000Z.tar.gz`);
    expect(remaining).not.toContain(`${BACKUP_PREFIX}20260601T010000Z.tar.gz`);
  });

  it('listBackups reports newest first with sizes', () => {
    seedData();
    createBackup(db, { backupsDir, now: () => new Date('2026-06-01T01:00:00Z') });
    createBackup(db, { backupsDir, now: () => new Date('2026-06-02T01:00:00Z') });
    const backups = listBackups(backupsDir);
    expect(backups.map((b) => b.name)).toEqual([
      `${BACKUP_PREFIX}20260602T010000Z.tar.gz`,
      `${BACKUP_PREFIX}20260601T010000Z.tar.gz`,
    ]);
    expect(backups[0]!.sizeBytes).toBeGreaterThan(0);
    expect(listBackups(join(dir, 'nope'))).toEqual([]);
  });

  it('manifest in the artifact matches the returned manifest', () => {
    seedData();
    const result = createBackup(db, { backupsDir, appVersion: '0.1.0' });
    const extract = mkdtempSync(join(tmpdir(), 'ynab-extract-'));
    try {
      execFileSync('tar', ['-xzf', result.artifactPath, '-C', extract]);
      const onDisk = JSON.parse(readFileSync(join(extract, MANIFEST_FILE_NAME), 'utf8')) as BackupManifest;
      expect(onDisk).toEqual(result.manifest);
    } finally {
      rmSync(extract, { recursive: true, force: true });
    }
  });
});
