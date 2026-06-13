import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CategoryStructureResponse, ManagedCategoryGroup } from '@tyche/shared';
import { INFLOW_READY_TO_ASSIGN_CATEGORY_ID } from '../db/seed.js';
import { BudgetError } from './errors.js';

/**
 * Category & group management (E3.S6, FR-9): create, rename, reorder, hide,
 * delete. Two binding rules:
 *
 *  - The seeded SYSTEM rows (the *Inflow: Ready to Assign* and *Reconciliation
 *    adjustment* categories and their group) are protected: any rename / hide /
 *    delete / move attempt → `system_protected` (AC-6). Their NAMES are also
 *    reserved — nothing can be renamed into collision with them.
 *
 *  - Deleting a category WITH history (transactions — split lines included —
 *    or month_assignments) requires a reassignment target. The whole
 *    reassign-then-delete runs in ONE SQLite transaction (NFR-12): transaction
 *    rows repoint to the target, assignments MERGE into the target per month
 *    (summing where both months exist — the recomputed totals are preserved by
 *    construction), payee suggestions follow, then the row is removed.
 *
 * Ordering is the existing integer `sort_order`; every write renumbers the
 * affected sibling list 0..n, so order stays dense and deterministic.
 */

interface CategoryRow {
  id: string;
  group_id: string;
  name: string;
  hidden: number;
  is_system: number;
}

interface GroupRow {
  id: string;
  name: string;
  hidden: number;
  is_system: number;
}

function requireGroup(db: Database.Database, id: string): GroupRow {
  const row = db
    .prepare('SELECT id, name, hidden, is_system FROM category_groups WHERE id = ?')
    .get(id) as GroupRow | undefined;
  if (!row) throw new BudgetError('group_not_found');
  return row;
}

function requireCategory(db: Database.Database, id: string): CategoryRow {
  const row = db
    .prepare('SELECT id, group_id, name, hidden, is_system FROM categories WHERE id = ?')
    .get(id) as CategoryRow | undefined;
  if (!row) throw new BudgetError('category_not_found');
  return row;
}

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') throw new BudgetError('invalid_name');
  return trimmed;
}

function assertGroupNameFree(db: Database.Database, name: string, excludeId?: string): void {
  const clash = db
    .prepare('SELECT id FROM category_groups WHERE name = ? COLLATE NOCASE AND id <> ?')
    .get(name, excludeId ?? '') as { id: string } | undefined;
  if (clash) throw new BudgetError('duplicate_group_name');
}

function assertCategoryNameFree(
  db: Database.Database,
  groupId: string,
  name: string,
  excludeId?: string,
): void {
  // System category names are reserved GLOBALLY (AC-6: no renaming into collision).
  const reserved = db
    .prepare('SELECT id FROM categories WHERE is_system = 1 AND name = ? COLLATE NOCASE')
    .get(name) as { id: string } | undefined;
  if (reserved) throw new BudgetError('duplicate_category_name');
  const clash = db
    .prepare('SELECT id FROM categories WHERE group_id = ? AND name = ? COLLATE NOCASE AND id <> ?')
    .get(groupId, name, excludeId ?? '') as { id: string } | undefined;
  if (clash) throw new BudgetError('duplicate_category_name');
}

/** Renumber a group's categories to the given dense order (0..n). */
function renumberCategories(db: Database.Database, groupId: string, orderedIds: string[]): void {
  const update = db.prepare('UPDATE categories SET sort_order = ?, group_id = ? WHERE id = ?');
  orderedIds.forEach((id, index) => update.run(index, groupId, id));
}

function categoryIdsInOrder(db: Database.Database, groupId: string): string[] {
  return (
    db
      .prepare('SELECT id FROM categories WHERE group_id = ? ORDER BY sort_order, name')
      .all(groupId) as { id: string }[]
  ).map((r) => r.id);
}

function nonSystemGroupIdsInOrder(db: Database.Database): string[] {
  return (
    db
      .prepare('SELECT id FROM category_groups WHERE is_system = 0 ORDER BY sort_order, name')
      .all() as { id: string }[]
  ).map((r) => r.id);
}

function clampIndex(index: number, length: number): number {
  if (index < 0) return 0;
  if (index > length) return length;
  return index;
}

// --- read: the management view ----------------------------------------------

export function getCategoryStructure(db: Database.Database): CategoryStructureResponse {
  const groups = db
    .prepare(
      'SELECT id, name, hidden FROM category_groups WHERE is_system = 0 ORDER BY sort_order, name',
    )
    .all() as { id: string; name: string; hidden: number }[];
  const categories = db.prepare(
    'SELECT id, name, hidden FROM categories WHERE group_id = ? ORDER BY sort_order, name',
  );
  return {
    groups: groups.map(
      (g): ManagedCategoryGroup => ({
        id: g.id,
        name: g.name,
        hidden: g.hidden === 1,
        categories: (categories.all(g.id) as { id: string; name: string; hidden: number }[]).map(
          (c) => ({ id: c.id, name: c.name, hidden: c.hidden === 1 }),
        ),
      }),
    ),
  };
}

// --- groups -------------------------------------------------------------------

export function createGroup(db: Database.Database, name: string): string {
  const clean = cleanName(name);
  assertGroupNameFree(db, clean);
  const id = randomUUID();
  const next = db
    .prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM category_groups')
    .get() as { next: number };
  db.prepare(
    'INSERT INTO category_groups (id, name, sort_order, hidden, is_system) VALUES (?, ?, ?, 0, 0)',
  ).run(id, clean, next.next);
  return id;
}

export interface GroupPatch {
  name?: string;
  hidden?: boolean;
  index?: number;
}

export function updateGroup(db: Database.Database, id: string, patch: GroupPatch): void {
  const group = requireGroup(db, id);
  if (group.is_system === 1) throw new BudgetError('system_protected');
  db.transaction(() => {
    if (patch.name !== undefined) {
      const clean = cleanName(patch.name);
      assertGroupNameFree(db, clean, id);
      db.prepare('UPDATE category_groups SET name = ? WHERE id = ?').run(clean, id);
    }
    if (patch.hidden !== undefined) {
      db.prepare('UPDATE category_groups SET hidden = ? WHERE id = ?').run(
        patch.hidden ? 1 : 0,
        id,
      );
    }
    if (patch.index !== undefined) {
      const order = nonSystemGroupIdsInOrder(db).filter((g) => g !== id);
      order.splice(clampIndex(patch.index, order.length), 0, id);
      const update = db.prepare('UPDATE category_groups SET sort_order = ? WHERE id = ?');
      // System group keeps sort_order 0; visible ordering starts after it.
      order.forEach((groupId, position) => update.run(position + 1, groupId));
    }
  })();
}

export function deleteGroup(db: Database.Database, id: string): void {
  const group = requireGroup(db, id);
  if (group.is_system === 1) throw new BudgetError('system_protected');
  const member = db.prepare('SELECT id FROM categories WHERE group_id = ? LIMIT 1').get(id);
  if (member) throw new BudgetError('group_not_empty'); // move/delete members first (story scope)
  db.prepare('DELETE FROM category_groups WHERE id = ?').run(id);
}

// --- categories ----------------------------------------------------------------

export function createCategory(db: Database.Database, groupId: string, name: string): string {
  const group = requireGroup(db, groupId);
  if (group.is_system === 1) throw new BudgetError('system_protected');
  const clean = cleanName(name);
  assertCategoryNameFree(db, groupId, clean);
  const id = randomUUID();
  const next = db
    .prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM categories WHERE group_id = ?')
    .get(groupId) as { next: number };
  db.prepare(
    'INSERT INTO categories (id, group_id, name, sort_order, hidden, is_system) VALUES (?, ?, ?, ?, 0, 0)',
  ).run(id, groupId, clean, next.next);
  return id;
}

export interface CategoryPatch {
  name?: string;
  hidden?: boolean;
  groupId?: string;
  index?: number;
}

export function updateCategory(db: Database.Database, id: string, patch: CategoryPatch): void {
  const category = requireCategory(db, id);
  if (category.is_system === 1) throw new BudgetError('system_protected');
  db.transaction(() => {
    const targetGroupId = patch.groupId ?? category.group_id;
    if (patch.name !== undefined) {
      const clean = cleanName(patch.name);
      assertCategoryNameFree(db, targetGroupId, clean, id);
      db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(clean, id);
    }
    if (patch.hidden !== undefined) {
      db.prepare('UPDATE categories SET hidden = ? WHERE id = ?').run(patch.hidden ? 1 : 0, id);
    }
    if (patch.groupId !== undefined || patch.index !== undefined) {
      const targetGroup = requireGroup(db, targetGroupId);
      if (targetGroup.is_system === 1) throw new BudgetError('system_protected');
      if (patch.groupId !== undefined && patch.groupId !== category.group_id) {
        // Cross-group: a same-named category may already live there.
        assertCategoryNameFree(db, targetGroupId, patch.name ?? category.name, id);
        renumberCategories(
          db,
          category.group_id,
          categoryIdsInOrder(db, category.group_id).filter((c) => c !== id),
        );
      }
      const order = categoryIdsInOrder(db, targetGroupId).filter((c) => c !== id);
      order.splice(clampIndex(patch.index ?? order.length, order.length), 0, id);
      renumberCategories(db, targetGroupId, order);
    }
  })();
}

export function deleteCategory(
  db: Database.Database,
  id: string,
  reassignToId: string | null,
): void {
  const category = requireCategory(db, id);
  if (category.is_system === 1) throw new BudgetError('system_protected');

  const hasHistory =
    db.prepare('SELECT 1 FROM transactions WHERE category_id = ? LIMIT 1').get(id) !== undefined ||
    db.prepare('SELECT 1 FROM month_assignments WHERE category_id = ? LIMIT 1').get(id) !==
      undefined;
  if (hasHistory && reassignToId === null) throw new BudgetError('reassignment_required');

  if (reassignToId !== null) {
    if (reassignToId === id || reassignToId === INFLOW_READY_TO_ASSIGN_CATEGORY_ID) {
      throw new BudgetError('invalid_reassignment_target');
    }
    const target = db.prepare('SELECT id FROM categories WHERE id = ?').get(reassignToId);
    if (!target) throw new BudgetError('invalid_reassignment_target');
  }

  db.transaction(() => {
    if (reassignToId !== null) {
      // Transactions — split LINES included, they are rows in this same table.
      db.prepare('UPDATE transactions SET category_id = ? WHERE category_id = ?').run(
        reassignToId,
        id,
      );
      // Assignments MERGE into the target per month: sum where both exist.
      // (`WHERE true` disambiguates the upsert grammar for INSERT…SELECT.)
      db.prepare(
        `INSERT INTO month_assignments (category_id, month, assigned_milliunits)
         SELECT ?, month, assigned_milliunits FROM month_assignments WHERE category_id = ? AND true
         ON CONFLICT (category_id, month) DO UPDATE SET
           assigned_milliunits = month_assignments.assigned_milliunits + excluded.assigned_milliunits,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      ).run(reassignToId, id);
      db.prepare('DELETE FROM month_assignments WHERE category_id = ?').run(id);
      // Keep the no-zero-row invariant when opposite-signed assignments cancel.
      db.prepare(
        'DELETE FROM month_assignments WHERE category_id = ? AND assigned_milliunits = 0',
      ).run(reassignToId);
    }
    // Payee suggestions follow the target (or clear) so the FK stays valid.
    db.prepare('UPDATE payees SET last_category_id = ? WHERE last_category_id = ?').run(
      reassignToId,
      id,
    );
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  })();
}
