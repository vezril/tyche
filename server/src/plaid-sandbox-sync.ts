import { seedPlaidCredentialsFromEnv, getPlaidCredentialsStatus, getPlaidEnvironment, getPlaidSecret } from './admin/plaid.js';
import { loadMasterKey } from './crypto/index.js';
import { openDatabase } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { seedSystemCategories } from './db/seed.js';
import { createPlaidSdkClient, listPlaidItems, listSyncLog, syncPlaidItem } from './importing/index.js';

/**
 * Manual sandbox verification entry point (E5.S2 Dev Notes; README "Plaid
 * sandbox"). The TEST SUITE never calls Plaid — it injects a fake at the
 * PlaidClientPort seam; THIS script is how the real SDK adapter is exercised
 * against Plaid's sandbox:
 *
 *   PLAID_ENV=sandbox PLAID_CLIENT_ID=… PLAID_SECRET=… MASTER_KEY=… \
 *     DATABASE_PATH=./data/app.db npm run sync:sandbox -w @ynab-clone/server
 *
 * It syncs every ACTIVE Item (link Items first through the app UI — Plaid's
 * sandbox accepts the user_good/pass_good test login) and prints the per-Item
 * results plus the tail of each sync-health log. Fire new sandbox
 * transactions from the Plaid dashboard, re-run, and watch the incremental
 * cursor pick up exactly the delta.
 */

const DATABASE_PATH = process.env['DATABASE_PATH'] ?? './data/app.db';

async function main(): Promise<void> {
  const masterKey = loadMasterKey(process.env);
  const db = openDatabase(DATABASE_PATH);
  runMigrations(db);
  seedSystemCategories(db);
  seedPlaidCredentialsFromEnv(db, masterKey, process.env);

  const status = getPlaidCredentialsStatus(db);
  const secret = status.configured ? getPlaidSecret(db, masterKey) : undefined;
  if (!status.configured || status.clientId === null || secret === undefined) {
    console.error('Plaid is not configured: set PLAID_CLIENT_ID/PLAID_SECRET or save them in Settings.');
    process.exit(1);
  }
  const environment = getPlaidEnvironment(db, process.env);
  console.log(`Plaid environment: ${environment} (database: ${DATABASE_PATH})`);

  const items = listPlaidItems(db);
  if (items.length === 0) {
    console.log('No linked Items. Link one through the app UI (Connections → Add bank connection) first.');
    return;
  }

  const client = createPlaidSdkClient({ clientId: status.clientId, secret, environment });
  for (const item of items) {
    if (item.status !== 'ACTIVE') {
      console.log(`- ${item.institutionName ?? item.plaidItemId}: skipped (status ${item.status})`);
      continue;
    }
    try {
      const result = await syncPlaidItem(db, masterKey, client, item.id);
      console.log(
        `- ${item.institutionName ?? item.plaidItemId}: ` +
          `+${String(result.addedCount)} added, ${String(result.mergedCount)} merged, ` +
          `${String(result.updatedCount)} updated, ` +
          `${String(result.removedVoidedCount + result.removedFlaggedCount)} removed, ` +
          `${String(result.duplicateCount)} duplicates, ` +
          `${String(result.ignoredUnmappedCount)} ignored (unmapped)`,
      );
    } catch (err) {
      console.error(`- ${item.institutionName ?? item.plaidItemId}: FAILED — ${String(err)}`);
    }
    for (const entry of listSyncLog(db, item.id, 3)) {
      console.log(`    ${entry.at} ${entry.outcome}${entry.errorCode ? ` (${entry.errorCode})` : ''}`);
    }
  }
  db.close();
}

void main();
