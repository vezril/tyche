import type Database from 'better-sqlite3';

/**
 * The migration-safety bracket's balance checksum (E7.S3 AC-3, NFR-11,
 * ADR-003): a canonical fingerprint of every historical balance input,
 * recorded BEFORE migrations run and verified AFTER. Any difference means a
 * migration silently altered history — boot aborts loudly.
 *
 * Deliberately built from raw rows only (per-account working/cleared sums,
 * row counts, total assignments) so the same query works on both sides of any
 * forward-only schema migration that doesn't itself redefine these tables —
 * and if one ever does, failing the bracket is exactly the right outcome.
 */

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

/** Canonical JSON checksum of balances; null when the ledger doesn't exist yet. */
export function computeBalanceChecksum(db: Database.Database): string | null {
  if (!tableExists(db, 'transactions') || !tableExists(db, 'accounts')) return null;

  const accounts = db
    .prepare(
      `SELECT a.id,
              COALESCE(SUM(t.amount_milliunits), 0) AS working,
              COALESCE(SUM(CASE WHEN t.status IN ('cleared', 'reconciled')
                                THEN t.amount_milliunits ELSE 0 END), 0) AS cleared,
              COUNT(t.id) AS rows
       FROM accounts a
       LEFT JOIN transactions t ON t.account_id = a.id AND t.parent_id IS NULL
       GROUP BY a.id ORDER BY a.id`,
    )
    .all() as { id: string; working: number; cleared: number; rows: number }[];

  const transactionCount = (
    db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }
  ).n;

  const assignedTotal = tableExists(db, 'month_assignments')
    ? (
        db
          .prepare(
            'SELECT COALESCE(SUM(assigned_milliunits), 0) AS total FROM month_assignments',
          )
          .get() as { total: number }
      ).total
    : 0;

  return JSON.stringify({ accounts, transactionCount, assignedTotal });
}
