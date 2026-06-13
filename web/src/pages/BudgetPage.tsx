import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  formatMilliunits,
  milliunits,
  parseDollarsToMilliunits,
  type BudgetCategoryMonth,
  type BudgetMonthResponse,
  type MoveMoneyRequest,
  type PutAssignmentRequest,
} from '@ynab-clone/shared';
import { apiGet, apiSend, describeError } from '../api.js';
import { formatDollars } from './AccountsSidebar.js';
import { clampMonth, currentMonth, isValidMonth, monthLabel, nextMonth, prevMonth } from '../months.js';

/**
 * The month-grid budget screen (E3.S2) with direct cell editing (E3.S3).
 *
 * Read model: one GET per viewed month (the full payload — ADR-005 recomputes
 * everything server-side, so the client never derives numbers it can fetch).
 * Write model: editing a category's Assigned cell PUTs on commit; the UI
 * updates optimistically with integer +/- milliunit patches (ADR-004) and the
 * server's recomputed response — which the mutation returns in full per
 * ADR-008 — always wins on arrival.
 *
 * Keyboard loop (NFR-9, UJ-2): every Assigned cell is a real <input> — Tab
 * walks them in row order, ArrowUp/ArrowDown jump rows, typing replaces the
 * value, Enter or blur commits, Escape cancels. Invalid input gets an inline
 * error and never reaches the API.
 */

interface Draft {
  categoryId: string;
  value: string;
}

interface CellError {
  categoryId: string;
  message: string;
}

/** The move-money popover's state (E3.S4): anchored to one category's row. */
interface MoveDraft {
  /** The category the popover was opened from. */
  categoryId: string;
  /** 'to' = cover this category from another; 'from' = send its money away. */
  direction: 'to' | 'from';
  /** The other end of the move. */
  otherId: string;
  amount: string;
  error: string | null;
}

/**
 * Optimistic patch: re-derive the one category, its group rollup, the month's
 * assigned total, and RTA from an assignment change — integer +/- only
 * (ADR-004). The server's recomputed payload replaces this on arrival.
 */
export function applyAssignment(
  data: BudgetMonthResponse,
  categoryId: string,
  assignedMilliunits: number,
): BudgetMonthResponse {
  let delta = 0;
  const groups = data.groups.map((group) => {
    const target = group.categories.find((c) => c.categoryId === categoryId);
    if (!target) return group;
    delta = assignedMilliunits - target.assignedMilliunits;
    return {
      ...group,
      assignedMilliunits: group.assignedMilliunits + delta,
      availableMilliunits: group.availableMilliunits + delta,
      categories: group.categories.map((c) =>
        c.categoryId === categoryId
          ? {
              ...c,
              assignedMilliunits,
              availableMilliunits: c.availableMilliunits + delta,
            }
          : c,
      ),
    };
  });
  return {
    ...data,
    groups,
    assignedThisMonthMilliunits: data.assignedThisMonthMilliunits + delta,
    rtaMilliunits: data.rtaMilliunits - delta,
  };
}

/**
 * Move = paired assignment adjustments (FR-5): two applyAssignment patches
 * whose RTA deltas cancel, so RTA is unchanged by construction — mirroring
 * the server's representation exactly.
 */
export function applyMove(
  data: BudgetMonthResponse,
  fromCategoryId: string,
  toCategoryId: string,
  amountMilliunits: number,
): BudgetMonthResponse {
  const all = data.groups.flatMap((g) => g.categories);
  const from = all.find((c) => c.categoryId === fromCategoryId);
  const to = all.find((c) => c.categoryId === toCategoryId);
  if (!from || !to) return data;
  return applyAssignment(
    applyAssignment(data, fromCategoryId, from.assignedMilliunits - amountMilliunits),
    toCategoryId,
    to.assignedMilliunits + amountMilliunits,
  );
}

function AvailablePill({
  amountMilliunits,
  onOpenMove,
  moveLabel,
}: {
  amountMilliunits: number;
  /** When set, the pill is the keyboard-operable move-money trigger (E3.S4 AC-5). */
  onOpenMove?: () => void;
  moveLabel?: string;
}): React.JSX.Element {
  const tone = amountMilliunits < 0 ? 'negative' : amountMilliunits > 0 ? 'positive' : 'zero';
  if (!onOpenMove) {
    return <span className={`available-pill ${tone}`}>{formatDollars(amountMilliunits)}</span>;
  }
  return (
    <button
      type="button"
      className={`available-pill ${tone}`}
      aria-label={moveLabel}
      aria-haspopup="dialog"
      onClick={onOpenMove}
    >
      {formatDollars(amountMilliunits)}
    </button>
  );
}

export default function BudgetPage(): React.JSX.Element {
  const [month, setMonth] = useState(currentMonth);
  const [data, setData] = useState<BudgetMonthResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const [cellError, setCellError] = useState<CellError | null>(null);
  const [mover, setMover] = useState<MoveDraft | null>(null);
  // Monotonic request token: a response (GET or PUT) only applies if it is
  // still the latest request — month switches and rapid edits never clobber
  // newer state with an older payload.
  const reqSeq = useRef(0);
  const cellRefs = useRef(new Map<string, HTMLInputElement>());

  const load = useCallback(async (m: string): Promise<void> => {
    const token = ++reqSeq.current;
    setLoadError(null);
    try {
      const res = await apiGet<BudgetMonthResponse>(`/api/budget/${m}`);
      if (token === reqSeq.current) setData(res);
    } catch (err) {
      if (token === reqSeq.current) setLoadError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void load(month);
  }, [month, load]);

  const bounds = data?.bounds ?? null;
  const canPrev = !bounds || month > bounds.minMonth;
  const canNext = !bounds || month < bounds.maxMonth;

  const navigate = (target: string): void => {
    setDraft(null);
    setCellError(null);
    setMover(null);
    setMonth(bounds ? clampMonth(target, bounds.minMonth, bounds.maxMonth) : target);
  };

  const allCategories = data?.groups.flatMap((g) => g.categories) ?? [];

  /** Visible (expanded) categories in render order, for ArrowUp/ArrowDown. */
  const visibleCategoryIds =
    data?.groups.flatMap((g) =>
      collapsed[g.groupId] === true ? [] : g.categories.map((c) => c.categoryId),
    ) ?? [];

  const moveFocus = (fromCategoryId: string, step: -1 | 1): void => {
    const index = visibleCategoryIds.indexOf(fromCategoryId);
    const targetId = visibleCategoryIds[index + step];
    if (targetId !== undefined) cellRefs.current.get(targetId)?.focus();
  };

  const commit = async (category: BudgetCategoryMonth): Promise<void> => {
    if (!draft || draft.categoryId !== category.categoryId) return;
    const raw = draft.value.trim();
    let parsed: number;
    try {
      // Empty = unassign; amounts are whole cents (FR-32, AC-5 of E3.S3).
      parsed = raw === '' ? 0 : parseDollarsToMilliunits(raw);
    } catch {
      setCellError({
        categoryId: category.categoryId,
        message: 'Enter a dollars-and-cents amount (whole cents only).',
      });
      return;
    }
    setDraft(null);
    setCellError(null);
    if (parsed === category.assignedMilliunits) return; // unchanged: no API call
    const targetMonth = month;
    // Optimistic patch (< 200 ms perceived, NFR-1/ADR-008) …
    setData((d) => d && applyAssignment(d, category.categoryId, parsed));
    const token = ++reqSeq.current;
    try {
      // … reconciled by the server's recomputed month (the server always wins).
      const fresh = await apiSend<BudgetMonthResponse>(
        'PUT',
        `/api/budget/${targetMonth}/categories/${category.categoryId}`,
        { assigned: formatMilliunits(milliunits(parsed)) } satisfies PutAssignmentRequest,
      );
      if (token === reqSeq.current) setData(fresh);
    } catch (err) {
      if (token === reqSeq.current) {
        setCellError({ categoryId: category.categoryId, message: describeError(err) });
        void load(targetMonth); // roll back to authoritative numbers
      }
    }
  };

  const openMover = (category: BudgetCategoryMonth): void => {
    const firstOther = allCategories.find((c) => c.categoryId !== category.categoryId);
    if (!firstOther) return; // a one-category budget has nowhere to move money
    setMover({
      categoryId: category.categoryId,
      direction: 'to', // typical gesture: cover an overspend FROM another category (UJ-5)
      otherId: firstOther.categoryId,
      amount: '',
      error: null,
    });
  };

  /** Warn (never block) when the chosen move overspends its source (AC-3, FR-7). */
  const moveWarning = ((): string | null => {
    if (!mover) return null;
    let amount: number;
    try {
      amount = parseDollarsToMilliunits(mover.amount);
    } catch {
      return null;
    }
    if (amount <= 0) return null;
    const sourceId = mover.direction === 'to' ? mover.otherId : mover.categoryId;
    const source = allCategories.find((c) => c.categoryId === sourceId);
    if (!source || amount <= source.availableMilliunits) return null;
    return `This will overspend ${source.name} by ${formatDollars(
      amount - source.availableMilliunits,
    )}.`;
  })();

  const commitMove = async (): Promise<void> => {
    if (!mover) return;
    let amount: number;
    try {
      amount = parseDollarsToMilliunits(mover.amount);
    } catch {
      amount = 0;
    }
    if (amount <= 0) {
      setMover({ ...mover, error: 'Enter a positive dollars-and-cents amount.' });
      return;
    }
    const fromCategoryId = mover.direction === 'to' ? mover.otherId : mover.categoryId;
    const toCategoryId = mover.direction === 'to' ? mover.categoryId : mover.otherId;
    const targetMonth = month;
    setMover(null);
    // Optimistic paired adjustment (same pattern as assignment commits) …
    setData((d) => d && applyMove(d, fromCategoryId, toCategoryId, amount));
    const token = ++reqSeq.current;
    try {
      // … reconciled by the server's recomputed month (the server always wins).
      const fresh = await apiSend<BudgetMonthResponse>('POST', `/api/budget/${targetMonth}/move`, {
        fromCategoryId,
        toCategoryId,
        amount: formatMilliunits(milliunits(amount)),
      } satisfies MoveMoneyRequest);
      if (token === reqSeq.current) setData(fresh);
    } catch (err) {
      if (token === reqSeq.current) {
        setCellError({ categoryId: mover.categoryId, message: describeError(err) });
        void load(targetMonth); // roll back to authoritative numbers
      }
    }
  };

  const moverDialog = (category: BudgetCategoryMonth): React.JSX.Element | null => {
    if (mover?.categoryId !== category.categoryId) return null;
    const others = allCategories.filter((c) => c.categoryId !== category.categoryId);
    return (
      <div
        className="move-popover"
        role="dialog"
        aria-label={`Move money — ${category.name}`}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            setMover(null);
          }
        }}
      >
        <select
          aria-label="Direction"
          value={mover.direction}
          onChange={(e) => setMover({ ...mover, direction: e.target.value as 'to' | 'from' })}
        >
          <option value="to">Move money to {category.name}</option>
          <option value="from">Move money from {category.name}</option>
        </select>
        <input
          aria-label="Move amount"
          inputMode="decimal"
          placeholder="0.00"
          autoFocus
          value={mover.amount}
          onChange={(e) => setMover({ ...mover, amount: e.target.value, error: null })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void commitMove();
            }
          }}
        />
        <select
          aria-label="Other category"
          value={mover.otherId}
          onChange={(e) => setMover({ ...mover, otherId: e.target.value })}
        >
          {others.map((c) => (
            <option key={c.categoryId} value={c.categoryId}>
              {c.name} ({formatDollars(c.availableMilliunits)})
            </option>
          ))}
        </select>
        {moveWarning && (
          <p className="move-warning" role="status">
            {moveWarning}
          </p>
        )}
        {mover.error && (
          <p className="cell-error" role="alert">
            {mover.error}
          </p>
        )}
        <div className="move-actions">
          <button type="button" onClick={() => void commitMove()}>
            Move
          </button>
          <button type="button" onClick={() => setMover(null)}>
            Cancel
          </button>
        </div>
      </div>
    );
  };

  const onCellKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, category: BudgetCategoryMonth): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit(category);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDraft(null);
      setCellError(null);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); // blur fires on focus move → commit-on-blur applies
      moveFocus(category.categoryId, e.key === 'ArrowDown' ? 1 : -1);
    }
  };

  const cell = (category: BudgetCategoryMonth): React.JSX.Element => {
    const editing = draft?.categoryId === category.categoryId;
    const error = cellError?.categoryId === category.categoryId ? cellError.message : null;
    return (
      <td className="assigned-col">
        <input
          ref={(el) => {
            if (el) cellRefs.current.set(category.categoryId, el);
            else cellRefs.current.delete(category.categoryId);
          }}
          className={`assign-input${error ? ' invalid' : ''}`}
          inputMode="decimal"
          value={editing ? draft.value : formatMilliunits(milliunits(category.assignedMilliunits))}
          aria-label={`Assigned to ${category.name}`}
          onFocus={(e) => {
            setDraft({
              categoryId: category.categoryId,
              value: formatMilliunits(milliunits(category.assignedMilliunits)),
            });
            e.target.select();
          }}
          onChange={(e) => setDraft({ categoryId: category.categoryId, value: e.target.value })}
          onKeyDown={(e) => onCellKeyDown(e, category)}
          onBlur={() => void commit(category)}
        />
        {error && (
          <span className="cell-error" role="alert">
            {error}
          </span>
        )}
      </td>
    );
  };

  return (
    <section className="budget" aria-label="Budget">
      <header className="budget-header">
        <nav className="month-nav" aria-label="Month navigation">
          <button
            type="button"
            aria-label="Previous month"
            disabled={!canPrev}
            onClick={() => navigate(prevMonth(month))}
          >
            ◀
          </button>
          <h1>{monthLabel(month)}</h1>
          <button
            type="button"
            aria-label="Next month"
            disabled={!canNext}
            onClick={() => navigate(nextMonth(month))}
          >
            ▶
          </button>
          <input
            type="month"
            aria-label="Jump to month"
            value={month}
            min={bounds?.minMonth}
            max={bounds?.maxMonth}
            onChange={(e) => {
              if (isValidMonth(e.target.value)) navigate(e.target.value);
            }}
          />
        </nav>
        {data && (
          /* E3.S5 (FR-6): warn, never block — negative = over-assigned warning,
             positive = unassigned money prompting assignment, zero = the
             zero-based success state. Derived purely from the engine's value. */
          <div
            className={`rta-banner ${
              data.rtaMilliunits < 0 ? 'negative' : data.rtaMilliunits > 0 ? 'positive' : 'zero'
            }`}
            aria-label="Ready to Assign"
          >
            <span className="rta-amount">{formatDollars(data.rtaMilliunits)}</span>
            <span className="rta-label">
              {data.rtaMilliunits < 0
                ? 'Over-assigned — move money back'
                : data.rtaMilliunits > 0
                  ? 'Ready to Assign'
                  : 'Every dollar assigned'}
            </span>
          </div>
        )}
      </header>

      {loadError && (
        <p className="status error" role="alert">
          {loadError}
        </p>
      )}

      {data && (
        <table className="budget-table">
          <thead>
            <tr>
              <th>Category</th>
              <th className="amount-col">Assigned</th>
              <th className="amount-col activity-col">Activity</th>
              <th className="amount-col">Available</th>
            </tr>
          </thead>
          <tbody>
            {data.groups.map((group) => (
              <Fragment key={group.groupId}>
                <tr className="group-row">
                  <th scope="rowgroup">
                    <button
                      type="button"
                      className="group-toggle"
                      aria-expanded={collapsed[group.groupId] !== true}
                      onClick={() =>
                        setCollapsed((c) => ({ ...c, [group.groupId]: c[group.groupId] !== true }))
                      }
                    >
                      {collapsed[group.groupId] === true ? '▸' : '▾'} {group.name}
                    </button>
                  </th>
                  <td className="amount-col">{formatDollars(group.assignedMilliunits)}</td>
                  <td className="amount-col activity-col">
                    {formatDollars(group.activityMilliunits)}
                  </td>
                  <td className="amount-col">
                    <AvailablePill amountMilliunits={group.availableMilliunits} />
                  </td>
                </tr>
                {collapsed[group.groupId] !== true &&
                  group.categories.map((category) => (
                    <tr key={category.categoryId} className="category-row">
                      <td className="category-name">{category.name}</td>
                      {cell(category)}
                      <td className="amount-col activity-col">
                        {formatDollars(category.activityMilliunits)}
                      </td>
                      <td className="amount-col available-col">
                        <AvailablePill
                          amountMilliunits={category.availableMilliunits}
                          onOpenMove={() => openMover(category)}
                          moveLabel={`Move money (${category.name})`}
                        />
                        {moverDialog(category)}
                      </td>
                    </tr>
                  ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
      {data && data.groups.length === 0 && (
        <p className="sidebar-empty">No budget categories yet.</p>
      )}
    </section>
  );
}
