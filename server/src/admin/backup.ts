import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

/**
 * Backup & restore (E7.S1, FR-35, NFR-7, ADR-003).
 *
 * Backup = `VACUUM INTO` snapshot (point-in-time consistent, safe while the
 * app runs) + a settings manifest, packed into ONE timestamped `.tar.gz` in
 * the backups directory. The artifact deliberately contains ciphertext only:
 * the MASTER_KEY lives in `.env`, never in the database, so it can never be
 * in a backup (ADR-007 — restoring without the original key recovers all app
 * data; only Plaid secrets/tokens become unreadable → re-link).
 *
 * Restore runs against a stopped app: extract, verify SQLite integrity, swap
 * the database file into place (the previous one is kept aside, WAL/SHM
 * removed so the restored snapshot is the entire state). Forward-only
 * migrations mean an older artifact restored into a newer app simply migrates
 * at next boot (ADR-003).
 *
 * Packing/unpacking uses the system `tar` (present in Debian slim and macOS);
 * no archive dependency enters the supply chain for a security-sensitive path.
 */

export const SNAPSHOT_FILE_NAME = 'app.db';
export const MANIFEST_FILE_NAME = 'manifest.json';
export const BACKUP_PREFIX = 'tyche-backup-';
/** Keep the N most recent scheduled artifacts (E7.S1 AC-5 retention). */
export const DEFAULT_BACKUP_RETENTION = 14;
/** Settings key stamped by the daily scheduler (RPO ≤ 24 h bookkeeping). */
export const LAST_BACKUP_SETTING_KEY = 'backup_last_run_at';

export interface BackupManifest {
  format: 'tyche-backup/1';
  createdAt: string;
  appVersion: string;
  /** Applied schema migrations at backup time (restore-compat documentation). */
  schemaMigrations: string[];
  /** Non-secret settings rows, for human inspection of the artifact. */
  settings: Record<string, string>;
  counts: { accounts: number; transactions: number };
  /** Always false — the MASTER_KEY is excluded by design (ADR-007). */
  masterKeyIncluded: false;
  note: string;
}

export interface BackupResult {
  /** Absolute path of the artifact. */
  artifactPath: string;
  name: string;
  sizeBytes: number;
  createdAt: string;
  manifest: BackupManifest;
}

export interface CreateBackupOptions {
  backupsDir: string;
  appVersion?: string;
  now?: () => Date;
  /** Artifact name prefix; the pre-migration auto-backup (E7.S3) brands its own. */
  prefix?: string;
}

function runTar(args: string[]): void {
  const result = spawnSync('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`tar ${args[0] ?? ''} failed: ${result.stderr.toString().trim()}`);
  }
}

/** `2026-06-12T03:04:05.123Z` → `20260612T030405Z` (filesystem-safe, sortable). */
function timestampSlug(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
}

function buildManifest(db: Database.Database, createdAt: string, appVersion: string): BackupManifest {
  const schemaMigrations = (
    db.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as { name: string }[]
  ).map((r) => r.name);
  const settings: Record<string, string> = {};
  for (const row of db.prepare('SELECT key, value FROM settings ORDER BY key').iterate() as IterableIterator<{
    key: string;
    value: string;
  }>) {
    settings[row.key] = row.value;
  }
  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM accounts) AS accounts,
              (SELECT COUNT(*) FROM transactions) AS transactions`,
    )
    .get() as { accounts: number; transactions: number };
  return {
    format: 'tyche-backup/1',
    createdAt,
    appVersion,
    schemaMigrations,
    settings,
    counts,
    masterKeyIncluded: false,
    note: 'Secrets are AES-256-GCM ciphertext; the MASTER_KEY lives in .env and must be backed up separately (ADR-007).',
  };
}

/**
 * One backup: VACUUM INTO snapshot + manifest → single timestamped `.tar.gz`
 * (E7.S1 AC-1). Safe while the app is serving traffic (ADR-003).
 */
export function createBackup(db: Database.Database, options: CreateBackupOptions): BackupResult {
  const { backupsDir, appVersion = 'unknown', now = () => new Date(), prefix = BACKUP_PREFIX } = options;
  mkdirSync(backupsDir, { recursive: true });
  const createdAtDate = now();
  const createdAt = createdAtDate.toISOString();
  const name = `${prefix}${timestampSlug(createdAtDate)}.tar.gz`;
  const artifactPath = join(backupsDir, name);

  const staging = mkdtempSync(join(tmpdir(), 'tyche-backup-'));
  try {
    // Point-in-time consistent snapshot, online (ADR-003 mechanism).
    db.prepare('VACUUM INTO ?').run(join(staging, SNAPSHOT_FILE_NAME));
    const manifest = buildManifest(db, createdAt, appVersion);
    writeFileSync(join(staging, MANIFEST_FILE_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
    runTar(['-czf', artifactPath, '-C', staging, SNAPSHOT_FILE_NAME, MANIFEST_FILE_NAME]);
    return { artifactPath, name, sizeBytes: statSync(artifactPath).size, createdAt, manifest };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export interface BackupArtifact {
  name: string;
  sizeBytes: number;
  createdAt: string;
}

/** Backups on disk, newest first (timestamped names sort lexicographically). */
export function listBackups(backupsDir: string): BackupArtifact[] {
  if (!existsSync(backupsDir)) return [];
  return readdirSync(backupsDir)
    .filter((f) => f.endsWith('.tar.gz'))
    .sort()
    .reverse()
    .map((name) => {
      const stat = statSync(join(backupsDir, name));
      return { name, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
    });
}

/**
 * Keep-N retention over the SCHEDULED artifacts (E7.S1 AC-5). Only files with
 * the given prefix are considered — pre-migration safety backups and anything
 * Calvin copied in by hand are never reaped.
 */
export function pruneBackups(
  backupsDir: string,
  keep: number,
  prefix: string = BACKUP_PREFIX,
): string[] {
  if (!Number.isInteger(keep) || keep < 1) throw new RangeError('retention must be a positive integer');
  if (!existsSync(backupsDir)) return [];
  const candidates = readdirSync(backupsDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.tar.gz'))
    .sort()
    .reverse(); // newest first
  const pruned = candidates.slice(keep);
  for (const name of pruned) unlinkSync(join(backupsDir, name));
  return pruned;
}

export interface RestoreResult {
  manifest: BackupManifest | null;
  /** Where the pre-restore database was moved, when one existed. */
  replacedDatabasePath: string | null;
}

/**
 * One-command restore (E7.S1 AC-2): extract the artifact, verify the snapshot
 * passes SQLite's integrity check, and swap it in as THE database. Must run
 * against a stopped app (documented in the README restore procedure). The next
 * boot runs any pending forward-only migrations against the restored data.
 */
export function restoreBackup(artifactPath: string, databasePath: string, now: () => Date = () => new Date()): RestoreResult {
  if (!existsSync(artifactPath)) throw new Error(`backup artifact not found: ${artifactPath}`);
  const staging = mkdtempSync(join(tmpdir(), 'tyche-restore-'));
  try {
    runTar(['-xzf', artifactPath, '-C', staging]);
    const snapshotPath = join(staging, SNAPSHOT_FILE_NAME);
    if (!existsSync(snapshotPath)) {
      throw new Error(`artifact does not contain ${SNAPSHOT_FILE_NAME}: ${artifactPath}`);
    }

    // Refuse to install a corrupt snapshot — better no restore than a bad one.
    const snapshot = new Database(snapshotPath, { readonly: true });
    try {
      const integrity = snapshot.pragma('integrity_check') as { integrity_check: string }[];
      if (integrity[0]?.integrity_check !== 'ok') {
        throw new Error(`snapshot failed integrity check: ${JSON.stringify(integrity)}`);
      }
    } finally {
      snapshot.close();
    }

    const manifestPath = join(staging, MANIFEST_FILE_NAME);
    const manifest = existsSync(manifestPath)
      ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest)
      : null;

    // Swap in: keep the old DB aside (never destroy data), drop WAL/SHM so the
    // snapshot alone is the complete state.
    mkdirSync(dirname(databasePath), { recursive: true });
    let replacedDatabasePath: string | null = null;
    if (existsSync(databasePath)) {
      replacedDatabasePath = `${databasePath}.replaced-${timestampSlug(now())}`;
      renameSync(databasePath, replacedDatabasePath);
    }
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${databasePath}${suffix}`;
      if (existsSync(sidecar)) unlinkSync(sidecar);
    }
    copyFileSync(snapshotPath, databasePath);
    return { manifest, replacedDatabasePath };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
