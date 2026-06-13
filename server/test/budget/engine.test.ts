import { describe, expect, it } from 'vitest';
import { milliunits, type Milliunits } from '@tyche/shared';
import {
  categoryMonthKey,
  computeBudget,
  type EngineInput,
  type MonthValues,
} from '../../src/budget/engine.js';

// E3.S1, the audited fold (ADR-005 / architecture §5). These tests ARE the
// spec for the money math:
//
//   available(c, m)  = carryover(c, m) + assigned(c, m) + activity(c, m)   (FR-1)
//   carryover(c, m)  = max(0, available(c, m−1))                           (FR-8, AS-1)
//   deduction(m)     = Σ_c max(0, −available(c, m−1))                      (AS-1)
//   RTA(m)           = Σ inflows ≤ m − Σ assigned ≤ m − Σ deductions ≤ m   (FR-3)

const M = (n: number): Milliunits => milliunits(n);

interface Sparse {
  categoryIds: string[];
  activity?: Record<string, number>; // 'cat|month' -> milliunits
  assigned?: Record<string, number>;
  inflows?: Record<string, number>; // month -> milliunits
}

function input(s: Sparse): EngineInput {
  const toMap = (rec: Record<string, number> = {}, keyed: boolean): ReadonlyMap<string, Milliunits> =>
    new Map(
      Object.entries(rec).map(([k, v]) => {
        if (!keyed) return [k, M(v)] as const;
        const [cat, month] = k.split('|') as [string, string];
        return [categoryMonthKey(cat, month), M(v)] as const;
      }),
    );
  return {
    categoryIds: s.categoryIds,
    activity: toMap(s.activity, true),
    assigned: toMap(s.assigned, true),
    inflowsByMonth: toMap(s.inflows, false),
  };
}

function monthOf(result: Map<string, MonthValues>, month: string): MonthValues {
  const v = result.get(month);
  expect(v, `expected month ${month} in fold output`).toBeDefined();
  return v!;
}

describe('computeBudget — the formulas (AC-1, AC-3, AC-5)', () => {
  it('AC-1: $50 carryover + $200 assigned + −$120 activity → available 130_000 milliunits (FR-1)', () => {
    const result = computeBudget(
      input({
        categoryIds: ['groceries'],
        // May ends at +$50 → June carryover $50.
        assigned: { 'groceries|2026-05': 50_000, 'groceries|2026-06': 200_000 },
        activity: { 'groceries|2026-06': -120_000 },
        inflows: { '2026-05': 1_000_000 },
      }),
      '2026-06',
    );
    const june = monthOf(result, '2026-06').categories.get('groceries')!;
    expect(june).toEqual({
      carryoverMilliunits: 50_000,
      assignedMilliunits: 200_000,
      activityMilliunits: -120_000,
      availableMilliunits: 130_000,
    });
  });

  it('AC-3: a June overspend of $40 does NOT carry; July RTA is exactly $40 lower (FR-8, AS-1)', () => {
    const base: Sparse = {
      categoryIds: ['dining'],
      inflows: { '2026-06': 1_000_000 },
    };
    const withoutOverspend = computeBudget(input(base), '2026-07');
    const withOverspend = computeBudget(
      input({ ...base, activity: { 'dining|2026-06': -40_000 } }),
      '2026-07',
    );

    const july = monthOf(withOverspend, '2026-07').categories.get('dining')!;
    expect(july.carryoverMilliunits).toBe(0); // the negative restarts at $0
    expect(july.availableMilliunits).toBe(0);

    // June's RTA is untouched by the overspend; July's is exactly $40 lower.
    expect(monthOf(withOverspend, '2026-06').rtaMilliunits).toBe(
      monthOf(withoutOverspend, '2026-06').rtaMilliunits,
    );
    expect(monthOf(withOverspend, '2026-07').rtaMilliunits).toBe(
      monthOf(withoutOverspend, '2026-07').rtaMilliunits - 40_000,
    );
    expect(monthOf(withOverspend, '2026-07').overspendDeductedMilliunits).toBe(40_000);
  });

  it('AC-3: a June surplus of $40 carries into July as carryover', () => {
    const result = computeBudget(
      input({
        categoryIds: ['dining'],
        assigned: { 'dining|2026-06': 40_000 },
        inflows: { '2026-06': 1_000_000 },
      }),
      '2026-07',
    );
    const july = monthOf(result, '2026-07').categories.get('dining')!;
    expect(july.carryoverMilliunits).toBe(40_000);
    expect(july.availableMilliunits).toBe(40_000);
  });

  it('AC-2 (engine view): a $1,000 inflow raises RTA by $1,000; assigning $1,000 returns it', () => {
    const before = computeBudget(input({ categoryIds: ['a', 'b'] }), '2026-06');
    const inflow = computeBudget(
      input({ categoryIds: ['a', 'b'], inflows: { '2026-06': 1_000_000 } }),
      '2026-06',
    );
    expect(monthOf(inflow, '2026-06').rtaMilliunits).toBe(
      monthOf(before, '2026-06').rtaMilliunits + 1_000_000,
    );
    const assignedBack = computeBudget(
      input({
        categoryIds: ['a', 'b'],
        inflows: { '2026-06': 1_000_000 },
        assigned: { 'a|2026-06': 600_000, 'b|2026-06': 400_000 },
      }),
      '2026-06',
    );
    expect(monthOf(assignedBack, '2026-06').rtaMilliunits).toBe(
      monthOf(before, '2026-06').rtaMilliunits,
    );
  });

  it('AC-5: RTA(m) subtracts assignments in all months ≤ m, but NOT in months > m (FR-3)', () => {
    const result = computeBudget(
      input({
        categoryIds: ['a'],
        inflows: { '2026-01': 1_000_000 },
        assigned: { 'a|2026-03': 250_000 }, // future relative to Jan/Feb
      }),
      '2026-04',
    );
    expect(monthOf(result, '2026-01').rtaMilliunits).toBe(1_000_000); // future assignment invisible here
    expect(monthOf(result, '2026-02').rtaMilliunits).toBe(1_000_000);
    expect(monthOf(result, '2026-03').rtaMilliunits).toBe(750_000); // now it counts
    expect(monthOf(result, '2026-04').rtaMilliunits).toBe(750_000); // and stays counted
  });

  it('months with zero rows still appear: carryover and RTA flow through unchanged', () => {
    const result = computeBudget(
      input({
        categoryIds: ['a'],
        inflows: { '2026-01': 500_000 },
        assigned: { 'a|2026-01': 200_000 },
      }),
      '2026-04',
    );
    for (const month of ['2026-02', '2026-03', '2026-04']) {
      const values = monthOf(result, month);
      expect(values.rtaMilliunits).toBe(300_000);
      expect(values.categories.get('a')!.availableMilliunits).toBe(200_000);
      expect(values.categories.get('a')!.carryoverMilliunits).toBe(200_000);
      expect(values.overspendDeductedMilliunits).toBe(0);
    }
  });

  it('a month before any data computes to all zeros', () => {
    const result = computeBudget(
      input({ categoryIds: ['a'], inflows: { '2026-06': 500_000 } }),
      '2026-03',
    );
    const values = monthOf(result, '2026-03');
    expect(values.rtaMilliunits).toBe(0);
    expect(values.categories.get('a')).toEqual({
      carryoverMilliunits: 0,
      assignedMilliunits: 0,
      activityMilliunits: 0,
      availableMilliunits: 0,
    });
  });

  it('overspends deduct only once: a −$40 June overspend does not also reduce August', () => {
    const result = computeBudget(
      input({
        categoryIds: ['dining'],
        inflows: { '2026-06': 1_000_000 },
        activity: { 'dining|2026-06': -40_000 },
      }),
      '2026-08',
    );
    expect(monthOf(result, '2026-07').rtaMilliunits).toBe(960_000);
    expect(monthOf(result, '2026-08').rtaMilliunits).toBe(960_000); // not 920_000
    expect(monthOf(result, '2026-08').overspendDeductedMilliunits).toBe(0);
  });
});

// --- AC-6: property-style invariants over random datasets (FR-32, NFR-12) ---

/** Deterministic PRNG so failures reproduce. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const MONTHS = [
  '2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06',
  '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12',
];

function randomInput(seed: number): EngineInput {
  const rand = lcg(seed);
  const categoryIds = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
  const activity = new Map<string, Milliunits>();
  const assigned = new Map<string, Milliunits>();
  const inflowsByMonth = new Map<string, Milliunits>();
  for (const month of MONTHS) {
    if (rand() < 0.8) {
      inflowsByMonth.set(month, M(Math.floor(rand() * 3_000_000)));
    }
    for (const cat of categoryIds) {
      if (rand() < 0.7) {
        // mostly outflows, occasionally a refund-style positive
        const sign = rand() < 0.9 ? -1 : 1;
        activity.set(categoryMonthKey(cat, month), M(sign * Math.floor(rand() * 600_000)));
      }
      if (rand() < 0.6) {
        assigned.set(categoryMonthKey(cat, month), M(Math.floor(rand() * 500_000)));
      }
    }
  }
  return { categoryIds, activity, assigned, inflowsByMonth };
}

describe('computeBudget — invariants over random data (AC-6, NFR-12)', () => {
  const SEEDS = [1, 2, 3, 42, 1337, 99991, 2026, 7, 8, 9];

  it('conservation: RTA(m) + Σ available(c, m) = Σ inflows ≤ m + Σ activity ≤ m, every month, every seed', () => {
    for (const seed of SEEDS) {
      const engineInput = randomInput(seed);
      const result = computeBudget(engineInput, '2025-12');
      let cumInflows = 0;
      let cumActivity = 0;
      for (const month of MONTHS) {
        cumInflows += engineInput.inflowsByMonth.get(month) ?? 0;
        for (const cat of engineInput.categoryIds) {
          cumActivity += engineInput.activity.get(categoryMonthKey(cat, month)) ?? 0;
        }
        const values = monthOf(result, month);
        const totalAvailable = [...values.categories.values()].reduce(
          (sum, c) => sum + c.availableMilliunits,
          0,
        );
        expect(
          values.rtaMilliunits + totalAvailable,
          `seed ${seed}, month ${month}`,
        ).toBe(cumInflows + cumActivity);
      }
    }
  });

  it('internal recurrences hold: available/carryover/deduction/RTA definitions, every month', () => {
    for (const seed of SEEDS) {
      const engineInput = randomInput(seed);
      const result = computeBudget(engineInput, '2025-12');
      let prev: MonthValues | undefined;
      for (const month of MONTHS) {
        const values = monthOf(result, month);
        let expectedDeduction = 0;
        for (const cat of engineInput.categoryIds) {
          const c = values.categories.get(cat)!;
          const prevAvailable = prev?.categories.get(cat)?.availableMilliunits ?? 0;
          expect(c.carryoverMilliunits, `seed ${seed} ${cat} ${month}`).toBe(
            Math.max(0, prevAvailable),
          );
          expect(c.availableMilliunits).toBe(
            c.carryoverMilliunits + c.assignedMilliunits + c.activityMilliunits,
          );
          expectedDeduction += Math.max(0, -prevAvailable);
        }
        expect(values.overspendDeductedMilliunits, `seed ${seed} ${month}`).toBe(expectedDeduction);
        const prevRta = prev?.rtaMilliunits ?? 0;
        expect(values.rtaMilliunits, `seed ${seed} ${month}`).toBe(
          prevRta +
            values.inflowsMilliunits -
            values.assignedTotalMilliunits -
            values.overspendDeductedMilliunits,
        );
        prev = values;
      }
    }
  });

  it('recompute is deterministic: same input, identical output', () => {
    for (const seed of SEEDS) {
      const engineInput = randomInput(seed);
      expect(computeBudget(engineInput, '2025-12')).toEqual(
        computeBudget(engineInput, '2025-12'),
      );
    }
  });

  it('all arithmetic stays in safe integer milliunits', () => {
    for (const seed of SEEDS) {
      const result = computeBudget(randomInput(seed), '2025-12');
      for (const values of result.values()) {
        expect(Number.isSafeInteger(values.rtaMilliunits)).toBe(true);
        expect(Number.isSafeInteger(values.overspendDeductedMilliunits)).toBe(true);
        for (const c of values.categories.values()) {
          for (const n of Object.values(c)) {
            expect(Number.isSafeInteger(n)).toBe(true);
          }
        }
      }
    }
  });

  it('an extra overspend of X in month M lowers RTA from M+1 on, by exactly X, and only then', () => {
    for (const seed of SEEDS) {
      const base = randomInput(seed);
      // A fresh category with NO other rows: any activity on it is pure overspend.
      const X = 123_456;
      const withOverspend: EngineInput = {
        ...base,
        categoryIds: [...base.categoryIds, 'fresh'],
        activity: new Map([
          ...base.activity,
          [categoryMonthKey('fresh', '2025-06'), M(-X)],
        ]),
      };
      const a = computeBudget(base, '2025-12');
      const b = computeBudget(withOverspend, '2025-12');
      for (const month of MONTHS) {
        const delta = monthOf(b, month).rtaMilliunits - monthOf(a, month).rtaMilliunits;
        expect(delta, `seed ${seed} ${month}`).toBe(month <= '2025-06' ? 0 : -X);
      }
    }
  });

  it('an assignment added in month M lowers RTA from M on, never before (AC-5)', () => {
    for (const seed of SEEDS) {
      const base = randomInput(seed);
      const X = 77_000;
      const existing = base.assigned.get(categoryMonthKey('c1', '2025-09')) ?? 0;
      const withAssignment: EngineInput = {
        ...base,
        assigned: new Map([
          ...base.assigned,
          [categoryMonthKey('c1', '2025-09'), M(existing + X)],
        ]),
      };
      const a = computeBudget(base, '2025-12');
      const b = computeBudget(withAssignment, '2025-12');
      for (const month of MONTHS) {
        const delta = monthOf(b, month).rtaMilliunits - monthOf(a, month).rtaMilliunits;
        if (month < '2025-09') {
          expect(delta, `seed ${seed} ${month}`).toBe(0);
        } else {
          // From M on, RTA is lower by X — except where the extra assignment
          // ALSO absorbed an overspend the base dataset was charging to RTA
          // (the assignment can only reduce later deductions, never increase
          // them), so the delta is bounded: −X ≤ delta ≤ 0, and exactly −X at M.
          if (month === '2025-09') expect(delta).toBe(-X);
          expect(delta, `seed ${seed} ${month}`).toBeGreaterThanOrEqual(-X);
          expect(delta, `seed ${seed} ${month}`).toBeLessThanOrEqual(0);
        }
      }
    }
  });
});
