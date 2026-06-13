import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { createBackup, listBackups, restoreBackup } from './admin/backup.js';
import { runConsistencyCheck } from './budget/index.js';
import { computeBudget } from './budget/engine.js';
import { loadEngineInputs } from './budget/queries.js';
import { monthOfDate } from './budget/month.js';

/**
 * The operator CLI (E7.S1, FR-35; architecture §8): `tyche <command>`.
 * In the container it is /usr/local/bin/tyche (see Dockerfile), so the
 * documented one-commands are exactly:
 *
 *   docker compose exec app tyche backup
 *   docker compose run --rm app tyche restore /data/backups/<artifact>
 *
 * `summary` prints a canonical JSON digest of balances, RTA, and transaction
 * counts — run it before backup on host A and after restore on host B and
 * `diff` the outputs: that IS the FR-35 scripted comparison (also automated in
 * the test suite). `check` is the NFR-12 consistency check with a non-zero
 * exit on mismatch (restore-drill friendly).
 */

const DATABASE_PATH = process.env['DATABASE_PATH'] ?? '/data/app.db';
const BACKUPS_DIR = process.env['BACKUPS_DIR'] ?? join(dirname(DATABASE_PATH), 'backups');

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { version: string };

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

interface Summary {
  transactionCount: number;
  accounts: { name: string; workingMilliunits: number; clearedMilliunits: number }[];
  rta: { month: string; rtaMilliunits: number } | null;
  consistencyOk: boolean;
}

/** Canonical digest for the FR-35 scripted comparison (host A vs host B diff). */
function buildSummary(databasePath: string): Summary {
  const db = openDatabase(databasePath);
  try {
    runMigrations(db); // an older artifact in a newer app migrates forward first
    const transactionCount = (
      db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }
    ).n;
    const accounts = db
      .prepare(
        `SELECT a.name,
                COALESCE(SUM(t.amount_milliunits), 0) AS workingMilliunits,
                COALESCE(SUM(CASE WHEN t.status IN ('cleared', 'reconciled')
                                  THEN t.amount_milliunits ELSE 0 END), 0) AS clearedMilliunits
         FROM accounts a
         LEFT JOIN transactions t ON t.account_id = a.id AND t.parent_id IS NULL
         GROUP BY a.id ORDER BY a.name`,
      )
      .all() as Summary['accounts'];
    const bounds = db
      .prepare(
        `SELECT MAX(m) AS latest FROM (
           SELECT substr(date, 1, 7) AS m FROM transactions
           UNION ALL SELECT month AS m FROM month_assignments)`,
      )
      .get() as { latest: string | null };
    const month = bounds.latest ?? monthOfDate(new Date().toISOString().slice(0, 10));
    const report = runConsistencyCheck(db, month);
    // RTA via the audited engine fold — the same path the grid serves.
    const rta =
      bounds.latest === null
        ? null
        : {
            month,
            rtaMilliunits:
              computeBudget(loadEngineInputs(db), month).get(month)?.rtaMilliunits ?? 0,
          };
    return { transactionCount, accounts, rta, consistencyOk: report.ok };
  } finally {
    db.close();
  }
}

const [, , command, ...args] = process.argv;

switch (command) {
  case 'backup': {
    const db = openDatabase(DATABASE_PATH);
    try {
      // A pending-migrations DB still snapshots fine — the restore target's
      // boot migrates it forward (ADR-003 forward-only).
      const result = createBackup(db, { backupsDir: BACKUPS_DIR, appVersion: pkg.version });
      console.log(`backup written: ${result.artifactPath} (${String(result.sizeBytes)} bytes)`);
      console.log('reminder: back up .env (MASTER_KEY) separately — it is NOT in the artifact (ADR-007).');
    } finally {
      db.close();
    }
    break;
  }

  case 'restore': {
    const artifact = args[0];
    if (!artifact) fail('usage: tyche restore <artifact.tar.gz>  (with the app STOPPED)');
    const result = restoreBackup(resolve(artifact), DATABASE_PATH);
    console.log(`restored ${artifact} -> ${DATABASE_PATH}`);
    if (result.replacedDatabasePath) {
      console.log(`previous database kept at ${result.replacedDatabasePath}`);
    }
    if (result.manifest) {
      console.log(`artifact created ${result.manifest.createdAt} by app ${result.manifest.appVersion}`);
    }
    console.log('post-restore summary (compare with the source host):');
    console.log(JSON.stringify(buildSummary(DATABASE_PATH), null, 2));
    break;
  }

  case 'backups': {
    for (const b of listBackups(BACKUPS_DIR)) {
      console.log(`${b.name}\t${String(b.sizeBytes)} bytes\t${b.createdAt}`);
    }
    break;
  }

  case 'summary': {
    console.log(JSON.stringify(buildSummary(DATABASE_PATH), null, 2));
    break;
  }

  case 'check': {
    const db = openDatabase(DATABASE_PATH);
    try {
      runMigrations(db);
      const report = runConsistencyCheck(
        db,
        monthOfDate(new Date().toISOString().slice(0, 10)),
      );
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok) process.exit(1);
    } finally {
      db.close();
    }
    break;
  }

  default:
    console.error(
      'usage: tyche <backup | restore <artifact> | backups | summary | check>',
    );
    process.exit(command === undefined || command === 'help' ? 0 : 1);
}
