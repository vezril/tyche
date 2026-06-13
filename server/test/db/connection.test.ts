import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';

// ADR-003 / AC-2: SQLite opens in WAL mode with synchronous=FULL and foreign_keys=ON.

describe('openDatabase', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('opens with WAL journal mode', () => {
    dir = mkdtempSync(join(tmpdir(), 'tyche-db-'));
    const db = openDatabase(join(dir, 'app.db'));
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    db.close();
  });

  it('opens with synchronous=FULL (NFR-7 durability)', () => {
    dir = mkdtempSync(join(tmpdir(), 'tyche-db-'));
    const db = openDatabase(join(dir, 'app.db'));
    expect(db.pragma('synchronous', { simple: true })).toBe(2); // 2 = FULL
    db.close();
  });

  it('enforces foreign keys', () => {
    dir = mkdtempSync(join(tmpdir(), 'tyche-db-'));
    const db = openDatabase(join(dir, 'app.db'));
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('creates the parent directory if missing (named-volume first boot)', () => {
    dir = mkdtempSync(join(tmpdir(), 'tyche-db-'));
    const db = openDatabase(join(dir, 'nested', 'data', 'app.db'));
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    db.close();
  });
});
