import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AccountBalancesResponse,
  ApproveTransactionRequest,
  CategorySummary,
  RejectTransactionResponse,
  ReviewItemResponse,
  ReviewQueueResponse,
  TransactionMutationResponse,
  UnmatchTransactionResponse,
} from '@ynab-clone/shared';
import { apiGet, apiSend, describeError } from '../api.js';
import { formatDollars } from './AccountsSidebar.js';

/**
 * Review queue (E4.S2, FR-22): every unapproved transaction across accounts,
 * newest first — the daily confirm/edit loop (UJ-3). Approve / edit / reject
 * per row AND as keyboard shortcuts (J/K or arrows to move, A approve,
 * R reject, E edit, U unmatch — NFR-9's ≤2-minute review). T2 merges arrive
 * flagged with what the bank said, with Unmatch right there (E4.S3 AC-5) —
 * mis-merges should be noticed in passing, not hunted for.
 *
 * Editing here is category/payee/memo ONLY: the imported amount and date are
 * not even rendered as inputs (S2 AC-2).
 */

interface RowEdit {
  categoryId: string;
  payeeName: string;
  memo: string;
  /** Payee/memo inputs are revealed on demand; category is always editable. */
  expanded: boolean;
}

export function ReviewPage({
  categories,
  onBalances,
  onChanged,
}: {
  categories: CategorySummary[];
  /** Recomputed balances from each mutation — keeps the sidebar honest. */
  onBalances: (balances: AccountBalancesResponse[]) => void;
  /** Fires after any queue change so the shell can refresh the badge. */
  onChanged: () => void;
}): React.JSX.Element {
  const [items, setItems] = useState<ReviewItemResponse[] | null>(null);
  const [edits, setEdits] = useState<Record<string, RowEdit>>({});
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const reload = useCallback(async (): Promise<void> => {
    const res = await apiGet<ReviewQueueResponse>('/api/review');
    setItems(res.items);
    setEdits({});
    setSelected((index) => Math.max(0, Math.min(index, res.items.length - 1)));
  }, []);

  useEffect(() => {
    reload().catch((err: unknown) => setError(describeError(err)));
  }, [reload]);

  const groups = useMemo(() => {
    const byGroup = new Map<string, CategorySummary[]>();
    for (const c of categories) {
      const list = byGroup.get(c.groupName) ?? [];
      list.push(c);
      byGroup.set(c.groupName, list);
    }
    return [...byGroup.entries()];
  }, [categories]);

  const editFor = (item: ReviewItemResponse): RowEdit =>
    edits[item.transaction.id] ?? {
      // the import pre-suggests the payee's last-used category (FR-19)
      categoryId: item.transaction.categoryId ?? item.suggestedCategoryId ?? '',
      payeeName: item.transaction.payeeName ?? '',
      memo: item.transaction.memo,
      expanded: false,
    };

  const setEdit = (item: ReviewItemResponse, patch: Partial<RowEdit>): void => {
    setEdits((all) => ({ ...all, [item.transaction.id]: { ...editFor(item), ...patch } }));
  };

  const afterChange = async (balances: AccountBalancesResponse[], message: string): Promise<void> => {
    onBalances(balances);
    setNote(message);
    await reload();
    onChanged();
  };

  const approve = async (item: ReviewItemResponse): Promise<void> => {
    setError(null);
    const edit = editFor(item);
    const body: ApproveTransactionRequest = {
      categoryId: edit.categoryId === '' ? null : edit.categoryId,
      memo: edit.memo,
    };
    // transfers derive their payee from the pair — never patch it (FR-16)
    if (item.transaction.transferAccountId === null) {
      body.payeeName = edit.payeeName.trim() === '' ? null : edit.payeeName;
    }
    try {
      const res = await apiSend<TransactionMutationResponse>(
        'POST',
        `/api/transactions/${item.transaction.id}/approve`,
        body,
      );
      await afterChange(res.accountBalances, `Approved ${item.transaction.payeeName ?? 'transaction'}.`);
    } catch (err) {
      setError(describeError(err));
    }
  };

  const reject = async (item: ReviewItemResponse): Promise<void> => {
    setError(null);
    try {
      const res = await apiSend<RejectTransactionResponse>(
        'POST',
        `/api/transactions/${item.transaction.id}/reject`,
      );
      await afterChange(
        res.accountBalances,
        res.rememberedExternalId
          ? 'Rejected — this bank transaction will not come back on the next import.'
          : 'Rejected.',
      );
    } catch (err) {
      setError(describeError(err));
    }
  };

  const unmatch = async (item: ReviewItemResponse): Promise<void> => {
    setError(null);
    try {
      const res = await apiSend<UnmatchTransactionResponse>(
        'POST',
        `/api/transactions/${item.transaction.id}/unmatch`,
      );
      await afterChange(res.accountBalances, 'Unmatched — your transaction and the import are separate rows again.');
    } catch (err) {
      setError(describeError(err));
    }
  };

  // S2 AC-3: the whole loop is drivable from the keyboard.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!items || items.length === 0) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return; // typing wins
    const current = items[selected];
    const key = e.key.toLowerCase();
    if (key === 'j' || e.key === 'ArrowDown') {
      setSelected((i) => Math.min(i + 1, items.length - 1));
      e.preventDefault();
    } else if (key === 'k' || e.key === 'ArrowUp') {
      setSelected((i) => Math.max(i - 1, 0));
      e.preventDefault();
    } else if (key === 'a' && current) {
      void approve(current);
      e.preventDefault();
    } else if (key === 'r' && current) {
      void reject(current);
      e.preventDefault();
    } else if (key === 'e' && current) {
      setEdit(current, { expanded: !editFor(current).expanded });
      e.preventDefault();
    } else if (key === 'u' && current?.match) {
      void unmatch(current);
      e.preventDefault();
    }
  };

  if (items === null) {
    return (
      <section className="review">
        <h1>Review</h1>
        {error ? <p className="status error">{error}</p> : <p className="status">Loading…</p>}
      </section>
    );
  }

  return (
    <section
      className="review"
      onKeyDown={onKeyDown}
      tabIndex={-1}
      aria-label="Review imported transactions"
    >
      <h1>Review</h1>
      <p className="review-hint">
        {items.length === 0
          ? 'Nothing to review — all caught up.'
          : `${String(items.length)} transaction${items.length === 1 ? '' : 's'} awaiting approval. ` +
            'Keys: J/K move · A approve · R reject · E edit · U unmatch.'}
      </p>
      {note && <p className="status ok">{note}</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <ul className="review-list" ref={listRef}>
        {items.map((item, index) => {
          const t = item.transaction;
          const edit = editFor(item);
          return (
            <li
              key={t.id}
              className={`review-item${index === selected ? ' selected' : ''}${item.match ? ' matched' : ''}`}
              onClick={() => setSelected(index)}
              aria-current={index === selected ? 'true' : undefined}
            >
              <div className="review-main">
                <span className="review-account">{item.accountName}</span>
                <span className="review-date">{t.date}</span>
                <span className="review-payee">
                  {t.transferAccountName ? `Transfer: ${t.transferAccountName}` : (t.payeeName ?? '—')}
                </span>
                <select
                  value={edit.categoryId}
                  onChange={(e) => setEdit(item, { categoryId: e.target.value })}
                  disabled={t.lines.length > 0 || t.transferAccountId !== null}
                  aria-label={`Category for ${t.payeeName ?? t.date}`}
                >
                  <option value="">
                    {t.lines.length > 0 ? 'Split' : 'No category'}
                  </option>
                  {groups.map(([groupName, list]) => (
                    <optgroup key={groupName} label={groupName}>
                      {list.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                          {c.id === item.suggestedCategoryId ? ' (suggested)' : ''}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <span className={`review-amount${t.amountMilliunits < 0 ? ' outflow' : ' inflow'}`}>
                  {formatDollars(t.amountMilliunits)}
                </span>
                <span className="review-actions">
                  <button type="button" onClick={() => void approve(item)}>
                    Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => setEdit(item, { expanded: !edit.expanded })}
                    aria-expanded={edit.expanded}
                  >
                    Edit
                  </button>
                  <button type="button" onClick={() => void reject(item)}>
                    Reject
                  </button>
                </span>
              </div>
              {item.match && (
                <div className="review-match" role="note">
                  Matched with your existing transaction — bank said: {item.match.importedDate} ·{' '}
                  {item.match.importedPayee} · {formatDollars(item.match.importedAmountMilliunits)}.{' '}
                  <button type="button" className="link-button" onClick={() => void unmatch(item)}>
                    Unmatch
                  </button>
                </div>
              )}
              {edit.expanded && (
                <div className="review-edit">
                  {/* Imported amount/date are identity — not edit fields (S2 AC-2). */}
                  {t.transferAccountId === null && (
                    <label>
                      Payee{' '}
                      <input
                        value={edit.payeeName}
                        onChange={(e) => setEdit(item, { payeeName: e.target.value })}
                        aria-label="Edit payee"
                      />
                    </label>
                  )}
                  <label>
                    Memo{' '}
                    <input
                      value={edit.memo}
                      onChange={(e) => setEdit(item, { memo: e.target.value })}
                      aria-label="Edit memo"
                    />
                  </label>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
