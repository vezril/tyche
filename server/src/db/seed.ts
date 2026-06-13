import type Database from 'better-sqlite3';

/**
 * First-run seed (AC-7 of E1.S1; FR-18, architecture §5).
 *
 * The two protected system categories exist from the very first boot:
 *   - "Inflow: Ready to Assign"  — target of RTA inflows (budget math, E3.S1)
 *   - "Reconciliation adjustment" — balance-adjustment transactions (E2.S7)
 *
 * Fixed ids so every install (and every test) refers to them stably.
 * is_system = 1 marks them protected; category management (E3.S6) must refuse
 * to delete, hide, or rename rows with that flag.
 *
 * Idempotent via INSERT OR IGNORE on fixed primary keys — safe on every boot.
 */

export const SYSTEM_CATEGORY_GROUP_ID = 'system';
export const INFLOW_READY_TO_ASSIGN_CATEGORY_ID = 'system-inflow-ready-to-assign';
export const RECONCILIATION_ADJUSTMENT_CATEGORY_ID = 'system-reconciliation-adjustment';

export function seedSystemCategories(db: Database.Database): void {
  const seed = db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO category_groups (id, name, sort_order, hidden, is_system)
       VALUES (?, 'System', 0, 1, 1)`,
    ).run(SYSTEM_CATEGORY_GROUP_ID);

    const insertCategory = db.prepare(
      `INSERT OR IGNORE INTO categories (id, group_id, name, sort_order, hidden, is_system)
       VALUES (?, ?, ?, ?, 0, 1)`,
    );
    insertCategory.run(
      INFLOW_READY_TO_ASSIGN_CATEGORY_ID,
      SYSTEM_CATEGORY_GROUP_ID,
      'Inflow: Ready to Assign',
      0,
    );
    insertCategory.run(
      RECONCILIATION_ADJUSTMENT_CATEGORY_ID,
      SYSTEM_CATEGORY_GROUP_ID,
      'Reconciliation adjustment',
      1,
    );
  });
  seed();
}
