import { describe, expect, it, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  DEFAULT_POLLING_INTERVAL_HOURS,
  getPollingIntervalHours,
  MAX_POLLING_INTERVAL_HOURS,
  MIN_POLLING_INTERVAL_HOURS,
  POLLING_INTERVAL_SETTING_KEY,
  setPollingIntervalHours,
  setSetting,
} from '../../src/admin/settings.js';

// E1.S3 AC-4 (storage side): the polling interval is stored, validated, and
// readable; the scheduler that consumes it arrives in E5.S3.

describe('polling interval setting', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db);
  });

  it('defaults to 6 hours when unset', () => {
    expect(DEFAULT_POLLING_INTERVAL_HOURS).toBe(6);
    expect(getPollingIntervalHours(db)).toBe(6);
  });

  it('stores and reads back a valid interval', () => {
    setPollingIntervalHours(db, 12);
    expect(getPollingIntervalHours(db)).toBe(12);
  });

  it('accepts the range boundaries', () => {
    setPollingIntervalHours(db, MIN_POLLING_INTERVAL_HOURS);
    expect(getPollingIntervalHours(db)).toBe(MIN_POLLING_INTERVAL_HOURS);
    setPollingIntervalHours(db, MAX_POLLING_INTERVAL_HOURS);
    expect(getPollingIntervalHours(db)).toBe(MAX_POLLING_INTERVAL_HOURS);
  });

  it.each([0, -1, 25, 1.5, NaN, Infinity])('rejects invalid interval %s', (hours) => {
    expect(() => setPollingIntervalHours(db, hours)).toThrowError(RangeError);
    expect(getPollingIntervalHours(db)).toBe(DEFAULT_POLLING_INTERVAL_HOURS);
  });

  it('falls back to the default when the stored value is garbage', () => {
    setSetting(db, POLLING_INTERVAL_SETTING_KEY, 'not-a-number');
    expect(getPollingIntervalHours(db)).toBe(DEFAULT_POLLING_INTERVAL_HOURS);
  });
});
