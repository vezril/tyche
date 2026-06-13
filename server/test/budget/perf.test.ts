import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedSystemCategories, INFLOW_READY_TO_ASSIGN_CATEGORY_ID } from '../../src/db/seed.js';
import { getBudgetMonth } from '../../src/budget/index.js';
import { runConsistencyCheck } from '../../src/budget/consistency.js';

// AC-7 / NFR-1 / ADR-005: at the PRD ceiling (10k transactions, 40 categories,
// 60 months) a full month recompute must stay well inside the ADR-005
// escape-hatch trigger: p95 < 250 ms SERVER-SIDE. ADR-005 predicts single-digit
// milliseconds; this test is the tripwire that keeps recompute-on-read honest.

const TRANSACTION_COUNT = 10_000;
const CATEGORY_COUNT = 40;
const MONTH_COUNT = 60; // 2021-07 .. 2026-06
const P95_BUDGET_MS = 250;

function monthAt(index: number): string {
  // 2021-07 + index months
  const total = 2021 * 12 + 6 + index; // 0-based month number since year 0
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

describe('budget engine performance at the PRD ceiling (AC-7, NFR-1)', () => {
  let dir: string;
  let db: Database.Database;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tyche-e3-perf-'));
    db = openDatabase(join(dir, 'app.db'));
    runMigrations(db);
    seedSystemCategories(db);

    // Direct SQL seeding: this test measures READ performance, not the ledger.
    db.prepare(
      "INSERT INTO accounts (id, name, type, on_budget) VALUES ('acct-1', 'Chequing', 'chequing', 1)",
    ).run();
    db.prepare(
      "INSERT INTO accounts (id, name, type, on_budget) VALUES ('acct-2', 'TFSA', 'tracking', 0)",
    ).run();
    db.prepare("INSERT INTO category_groups (id, name, sort_order) VALUES ('pg', 'Seeded', 1)").run();
    const insertCategory = db.prepare(
      "INSERT INTO categories (id, group_id, name, sort_order) VALUES (?, 'pg', ?, ?)",
    );
    for (let c = 0; c < CATEGORY_COUNT; c++) {
      insertCategory.run(`cat-${c}`, `Category ${c}`, c);
    }

    const insertTransaction = db.prepare(
      `INSERT INTO transactions (id, account_id, date, amount_milliunits, category_id)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertAssignment = db.prepare(
      'INSERT INTO month_assignments (category_id, month, assigned_milliunits) VALUES (?, ?, ?)',
    );
    const seedAll = db.transaction(() => {
      for (let i = 0; i < TRANSACTION_COUNT; i++) {
        const month = monthAt(i % MONTH_COUNT);
        const day = String((i % 28) + 1).padStart(2, '0');
        if (i % 20 === 0) {
          // every 20th row is an income inflow to RTA
          insertTransaction.run(`t-${i}`, 'acct-1', `${month}-${day}`, 2_000_000, INFLOW_READY_TO_ASSIGN_CATEGORY_ID);
        } else if (i % 17 === 0) {
          // some tracking-account noise the engine must skip
          insertTransaction.run(`t-${i}`, 'acct-2', `${month}-${day}`, -((i % 300) + 1) * 1000, null);
        } else {
          insertTransaction.run(`t-${i}`, 'acct-1', `${month}-${day}`, -((i % 200) + 1) * 1000, `cat-${i % CATEGORY_COUNT}`);
        }
      }
      for (let m = 0; m < MONTH_COUNT; m++) {
        for (let c = 0; c < CATEGORY_COUNT; c++) {
          insertAssignment.run(`cat-${c}`, monthAt(m), 95_000);
        }
      }
    });
    seedAll();
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it(`recomputes the last month (full 60-month fold) with p95 < ${P95_BUDGET_MS} ms over 20 runs`, () => {
    const lastMonth = monthAt(MONTH_COUNT - 1);
    // Warm-up: statement preparation, page cache.
    getBudgetMonth(db, lastMonth, '2026-06-12');

    const samples: number[] = [];
    for (let run = 0; run < 20; run++) {
      const start = performance.now();
      const payload = getBudgetMonth(db, lastMonth, '2026-06-12');
      samples.push(performance.now() - start);
      expect(payload.groups.flatMap((g) => g.categories)).toHaveLength(CATEGORY_COUNT);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!;
    // Report the actual number in the test name output on failure.
    expect(p95, `p95 was ${p95.toFixed(2)} ms (samples: ${samples.map((s) => s.toFixed(1)).join(', ')})`).toBeLessThan(
      P95_BUDGET_MS,
    );
  });

  it('the seeded dataset is what AC-7 demands, and the consistency check passes on it', () => {
    const txCount = db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number };
    expect(txCount.n).toBe(TRANSACTION_COUNT);
    const report = runConsistencyCheck(db, monthAt(MONTH_COUNT - 1));
    expect(report.ok).toBe(true);
  });
});
