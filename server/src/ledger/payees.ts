import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { PayeeResponse } from '@ynab-clone/shared';

/**
 * Payees (FR-19): the list is built as a side effect of transaction entry and
 * import — there is no payee-management UI. Names are canonical: the first
 * spelling entered wins; later case-variant entries resolve to the same row.
 * `last_category_id` remembers the most recent categorization and powers the
 * default category suggestion in autocomplete.
 */

export interface Payee {
  id: string;
  name: string;
  lastCategoryId: string | null;
}

/**
 * Resolve a free-text payee name to its canonical row, creating it on first
 * sight (case-insensitive match). Blank input means "no payee" → null.
 */
export function getOrCreatePayee(db: Database.Database, rawName: string): Payee | null {
  const name = rawName.trim();
  if (name === '') return null;
  const existing = db
    .prepare('SELECT id, name, last_category_id FROM payees WHERE name = ? COLLATE NOCASE')
    .get(name) as { id: string; name: string; last_category_id: string | null } | undefined;
  if (existing) {
    return { id: existing.id, name: existing.name, lastCategoryId: existing.last_category_id };
  }
  const id = randomUUID();
  db.prepare('INSERT INTO payees (id, name) VALUES (?, ?)').run(id, name);
  return { id, name, lastCategoryId: null };
}

/** Remember the last category used with this payee (FR-19 default suggestion). */
export function recordPayeeCategory(
  db: Database.Database,
  payeeId: string,
  categoryId: string,
): void {
  db.prepare('UPDATE payees SET last_category_id = ? WHERE id = ?').run(categoryId, payeeId);
}

/**
 * Substring search over payee names (case-insensitive) for autocomplete;
 * empty/absent query returns the full list. Includes the last-used category.
 */
export function searchPayees(db: Database.Database, query?: string): PayeeResponse[] {
  const where = query ? "WHERE p.name LIKE '%' || ? || '%'" : '';
  const stmt = db.prepare(
    `SELECT p.id, p.name, p.last_category_id, c.name AS last_category_name
     FROM payees p LEFT JOIN categories c ON c.id = p.last_category_id
     ${where}
     ORDER BY p.name COLLATE NOCASE`,
  );
  const rows = (query ? stmt.all(query) : stmt.all()) as {
    id: string;
    name: string;
    last_category_id: string | null;
    last_category_name: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    lastCategoryId: r.last_category_id,
    lastCategoryName: r.last_category_name,
  }));
}
