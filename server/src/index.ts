import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedPlaidCredentialsFromEnv } from './admin/plaid.js';
import { loadMasterKey } from './crypto/index.js';
import { openDatabase } from './db/connection.js';
import { buildApp } from './web/app.js';
import { runStartupSequence } from './web/boot.js';
import { createBackupScheduler } from './web/backup-scheduler.js';
import { createPlaidScheduler, PlaidSyncGate } from './web/plaid-scheduler.js';

/**
 * Boot sequence per architecture §8 (E1.S1 AC-2, hardened by E7.S3/S4):
 *   0. load the MASTER_KEY (ADR-007) — missing/malformed means REFUSE to start
 *   1. open SQLite (WAL, synchronous=FULL, foreign_keys=ON — ADR-003)
 *   2. migration-safety bracket (NFR-11): pending migrations on existing data →
 *      automatic pre-migration backup + balance checksum before, verified
 *      after — abort loudly on mismatch
 *   3. first-run seed (system categories; Plaid creds from .env, E1.S3 AC-6)
 *   4. NFR-12 consistency check — mismatch is a loud warning + admin banner
 *   5. start HTTP, then the schedulers (Plaid polling + daily backup)
 */

const DATABASE_PATH = process.env['DATABASE_PATH'] ?? '/data/app.db';
const BACKUPS_DIR = process.env['BACKUPS_DIR'] ?? join(dirname(DATABASE_PATH), 'backups');
const PORT = Number(process.env['PORT'] ?? 8080);
const HOST = process.env['HOST'] ?? '0.0.0.0';
// In the production image the SPA bundle sits next to the server (see Dockerfile).
const SPA_DIR =
  process.env['SPA_DIR'] ?? fileURLToPath(new URL('../../web/dist', import.meta.url));

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { version: string };

// ADR-007: never start without a usable field-encryption key — failing here is
// the documented behavior (see README "First-run setup"), not auto-generation.
let masterKey: Buffer;
try {
  masterKey = loadMasterKey(process.env);
} catch (err) {
  console.error(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const db = openDatabase(DATABASE_PATH);

const bootLogger = {
  info: (obj: Record<string, unknown>, msg: string) => console.log(msg, JSON.stringify(obj)),
  error: (obj: Record<string, unknown>, msg: string) => console.error(msg, JSON.stringify(obj)),
};
let startup;
try {
  startup = runStartupSequence({
    db,
    backupsDir: BACKUPS_DIR,
    appVersion: pkg.version,
    logger: bootLogger,
  });
} catch (err) {
  // NFR-11: never serve silently-altered balances. The pre-migration backup
  // in data/backups/ is the way back.
  console.error(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const seededPlaid = seedPlaidCredentialsFromEnv(db, masterKey, process.env); // AC-6

// E5.S3 (ADR-006): ONE single-flight gate shared by the manual-sync route and
// the in-process polling scheduler, so runs never overlap per Item (AC-6).
const plaidSyncGate = new PlaidSyncGate();
const app = buildApp({
  db,
  version: pkg.version,
  spaDir: SPA_DIR,
  masterKey,
  plaidSyncGate,
  backupsDir: BACKUPS_DIR,
  bootConsistency: startup.consistency,
});
const scheduler = createPlaidScheduler({ db, masterKey, gate: plaidSyncGate, logger: app.log });
// E7.S1 AC-5: daily backup, in-process (RPO ≤ 24 h), keep-N retention.
const backupScheduler = createBackupScheduler({
  db,
  backupsDir: BACKUPS_DIR,
  appVersion: pkg.version,
  logger: app.log,
});
app.log.info(
  {
    applied: startup.appliedMigrations,
    preMigrationBackup: startup.preMigrationBackup?.name ?? null,
    consistencyOk: startup.consistency.ok,
    seededPlaid,
    databasePath: DATABASE_PATH,
  },
  'migrations complete, starting server',
);

app
  .listen({ port: PORT, host: HOST })
  .then(() => {
    // Start polling only once the server is up; an overdue slot from before
    // the restart polls promptly on the first check (S3 AC-3).
    scheduler.start();
    backupScheduler.start();
  })
  .catch((err: unknown) => {
    app.log.error(err);
    process.exit(1);
  });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    scheduler.stop();
    backupScheduler.stop();
    void app.close().then(() => {
      db.close();
      process.exit(0);
    });
  });
}
