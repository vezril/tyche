import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  formatMilliunits,
  milliunits,
  parseDollarsToMilliunits,
  type AccountBalancesResponse,
  type AccountResponse,
  type CategorySummary,
  type CreateTransactionRequest,
  type DeleteTransactionResponse,
  type PayeeResponse,
  type PayeesResponse,
  type ReconcileAccountRequest,
  type ReconcileAccountResponse,
  type ImportFileResponse,
  type RegisterResponse,
  type SplitLineRequest,
  type TransactionMutationResponse,
  type TransactionResponse,
  type UnmatchTransactionResponse,
  type UpdateTransactionRequest,
} from '@ynab-clone/shared';
import { ApiError, apiGet, apiSend, apiUpload, describeError } from '../api.js';
import { formatDollars } from './AccountsSidebar.js';

/**
 * Per-account register (E2.S2–S7): manual entry/edit, split editor (FR-15),
 * transfer entry via the account-as-payee pattern (FR-16), cleared-status
 * toggle + cleared/uncleared/working balances (FR-17), and the reconciliation
 * flow on the account header (FR-18).
 *
 * Keyboard flow (NFR-9): the entry form is a plain <form> — Tab moves field
 * to field, Enter commits; the cleared toggle is a real <button> in the row.
 * Payee autocomplete is a native <datalist> fed by the server's substring
 * search plus "Transfer: <account>" pseudo-payees (which are NEVER part of
 * the server's payee list — S5 AC-4). Amounts travel as dollar strings and
 * come back as milliunits, formatted only here at the UI edge (ADR-004); the
 * split editor's remaining figure is computed in integer milliunits.
 *
 * Reconciled rows are locked (FR-18): any mutation that hits one gets a 409,
 * surfaces a confirm(), and retries with ?force=true.
 */

const PAGE_SIZE = 100;
const TRANSFER_PREFIX = 'Transfer: ';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

interface Filters {
  search: string;
  from: string;
  to: string;
  categoryId: string;
}

const NO_FILTERS: Filters = { search: '', from: '', to: '', categoryId: '' };

function CategorySelect({
  categories,
  value,
  onChange,
  disabled,
  emptyLabel,
  label,
}: {
  categories: CategorySummary[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  emptyLabel: string;
  label?: string;
}): React.JSX.Element {
  const groups = useMemo(() => {
    const byGroup = new Map<string, CategorySummary[]>();
    for (const c of categories) {
      const list = byGroup.get(c.groupName) ?? [];
      list.push(c);
      byGroup.set(c.groupName, list);
    }
    return [...byGroup.entries()];
  }, [categories]);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled ?? false}
      aria-label={label ?? 'Category'}
    >
      <option value="">{emptyLabel}</option>
      {groups.map(([groupName, items]) => (
        <optgroup key={groupName} label={groupName}>
          {items.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

interface SplitLineForm {
  categoryId: string;
  /** Entered in the same outflow/inflow orientation as the parent total. */
  amount: string;
  memo: string;
}

interface FormState {
  /** Transaction id when editing, null when adding. */
  editingId: string | null;
  /** Editing one side of a transfer: payee is structural, not editable. */
  editingTransfer: boolean;
  /** The edited transaction had lines before (un-splitting must send splits: null). */
  wasSplit: boolean;
  date: string;
  payeeName: string;
  categoryId: string;
  memo: string;
  outflow: string;
  inflow: string;
  /** null = ordinary transaction; array = split editor open (FR-15). */
  splits: SplitLineForm[] | null;
}

const emptyLine = (): SplitLineForm => ({ categoryId: '', amount: '', memo: '' });

const emptyForm = (): FormState => ({
  editingId: null,
  editingTransfer: false,
  wasSplit: false,
  date: today(),
  payeeName: '',
  categoryId: '',
  memo: '',
  outflow: '',
  inflow: '',
  splits: null,
});

/** Parse a user-entered dollars value to milliunits, null when not parseable yet. */
function tryParse(value: string): number | null {
  try {
    return parseDollarsToMilliunits(value);
  } catch {
    return null;
  }
}

const STATUS_GLYPH: Record<TransactionResponse['status'], string> = {
  uncleared: '○',
  cleared: '●',
  reconciled: '◈',
};

export function RegisterPage({
  account,
  accounts,
  categories,
  onBalances,
  onAccountChanged,
  onImported,
}: {
  account: AccountResponse;
  /** All accounts — the entry form offers "Transfer: <name>" pseudo-payees (FR-16). */
  accounts: AccountResponse[];
  categories: CategorySummary[];
  /** Recomputed balances from a mutation response — reconciles the sidebar in one round trip. */
  onBalances: (balances: AccountBalancesResponse[]) => void;
  onAccountChanged: () => void;
  /** Fires after a file import / unmatch so the shell refreshes the review badge (E4). */
  onImported: () => void;
}): React.JSX.Element {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [sort, setSort] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState<RegisterResponse | null>(null);
  const [extraRows, setExtraRows] = useState<TransactionResponse[]>([]);
  const [payees, setPayees] = useState<PayeeResponse[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [error, setError] = useState<string | null>(null);
  const [expandedSplits, setExpandedSplits] = useState<Record<string, boolean>>({});
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [bankBalance, setBankBalance] = useState('');
  const [reconcileNote, setReconcileNote] = useState<string | null>(null);
  const [importNote, setImportNote] = useState<string | null>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const transferTargets = useMemo(
    () => accounts.filter((a) => a.id !== account.id && !a.closed),
    [accounts, account.id],
  );

  const registerUrl = useCallback(
    (offset: number): string => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), sort });
      if (offset > 0) params.set('offset', String(offset));
      if (filters.search) params.set('search', filters.search);
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);
      if (filters.categoryId) params.set('categoryId', filters.categoryId);
      return `/api/accounts/${account.id}/transactions?${params.toString()}`;
    },
    [account.id, filters, sort],
  );

  const reload = useCallback(async (): Promise<void> => {
    setPage(await apiGet<RegisterResponse>(registerUrl(0)));
    setExtraRows([]);
  }, [registerUrl]);

  useEffect(() => {
    reload().catch((err: unknown) => setError(describeError(err)));
  }, [reload]);

  const reloadPayees = useCallback(async (): Promise<void> => {
    setPayees((await apiGet<PayeesResponse>('/api/payees')).payees);
  }, []);
  useEffect(() => {
    void reloadPayees();
  }, [reloadPayees]);

  // FR-19: typing a known payee pre-suggests its last category — only while
  // the category field is untouched, so it never clobbers a manual choice.
  const onPayeeInput = (name: string): void => {
    setForm((f) => {
      const known = payees.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
      const suggested =
        account.onBudget && f.categoryId === '' && known?.lastCategoryId
          ? known.lastCategoryId
          : f.categoryId;
      return { ...f, payeeName: name, categoryId: suggested };
    });
  };

  const startEdit = (t: TransactionResponse): void => {
    const sign = t.amountMilliunits < 0 ? -1 : 1;
    setForm({
      editingId: t.id,
      editingTransfer: t.transferAccountId !== null,
      wasSplit: t.lines.length > 0,
      date: t.date,
      payeeName: t.transferAccountName
        ? `${TRANSFER_PREFIX}${t.transferAccountName}`
        : (t.payeeName ?? ''),
      categoryId: t.categoryId ?? '',
      memo: t.memo,
      outflow: t.amountMilliunits < 0 ? formatDollars(-t.amountMilliunits).slice(1) : '',
      inflow: t.amountMilliunits >= 0 ? formatDollars(t.amountMilliunits).slice(1) : '',
      // line amounts display in the parent's orientation (outflow shows positive)
      splits:
        t.lines.length > 0
          ? t.lines.map((l) => ({
              categoryId: l.categoryId ?? '',
              amount: formatMilliunits(milliunits(sign === -1 ? -l.amountMilliunits : l.amountMilliunits)),
              memo: l.memo,
            }))
          : null,
    });
    dateRef.current?.focus();
  };

  /**
   * Reconciled rows 409 without force (FR-18). One confirm() — the explicit
   * confirmation S7 AC-4 demands — then retry with ?force=true.
   */
  const withForceRetry = async <T,>(run: (forceQuery: string) => Promise<T>): Promise<T | null> => {
    try {
      return await run('');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'reconciled_transaction_locked') {
        if (!window.confirm('This transaction is reconciled. Change it anyway?')) return null;
        return run('?force=true');
      }
      throw err;
    }
  };

  // Outflow/inflow orientation of the entered total: -1 when Outflow is used.
  const orientation = form.outflow.trim() !== '' ? -1 : 1;

  /** A line's entered value → canonical signed dollars string for the API. */
  const lineToSignedDollars = (value: string): string | null => {
    const parsed = tryParse(value);
    if (parsed === null) return null;
    return formatMilliunits(milliunits(orientation === -1 ? -parsed : parsed));
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    const outflow = form.outflow.trim();
    const inflow = form.inflow.trim();
    if ((outflow === '') === (inflow === '')) {
      setError('Enter an amount in exactly one of Outflow or Inflow.');
      return;
    }
    const amount = outflow !== '' ? `-${outflow}` : inflow;

    let splits: SplitLineRequest[] | undefined;
    if (form.splits !== null) {
      splits = [];
      for (const line of form.splits) {
        const signed = lineToSignedDollars(line.amount);
        if (signed === null) {
          setError('Enter a dollars-and-cents amount on every split line.');
          return;
        }
        splits.push({
          categoryId: line.categoryId === '' ? null : line.categoryId,
          amount: signed,
          memo: line.memo,
        });
      }
    }

    const payeeName = form.payeeName.trim();
    const transferTarget = transferTargets.find(
      (a) => `${TRANSFER_PREFIX}${a.name}`.toLowerCase() === payeeName.toLowerCase(),
    );

    try {
      let result: TransactionMutationResponse | null;
      if (form.editingId) {
        const body: UpdateTransactionRequest = {
          date: form.date,
          amount,
          categoryId: form.categoryId === '' ? null : form.categoryId,
          memo: form.memo,
        };
        // payee is structural on a transfer (derived from the pair) — never patched
        if (!form.editingTransfer) body.payeeName = payeeName === '' ? null : form.payeeName;
        if (splits !== undefined) body.splits = splits;
        else if (form.wasSplit) body.splits = null; // un-split (S4 AC-4)
        if (form.splits !== null) delete body.categoryId; // parent carries no category
        const id = form.editingId;
        result = await withForceRetry((forceQuery) =>
          apiSend<TransactionMutationResponse>('PATCH', `/api/transactions/${id}${forceQuery}`, body),
        );
      } else if (transferTarget && splits === undefined) {
        const body: CreateTransactionRequest = {
          accountId: account.id,
          date: form.date,
          amount,
          transferAccountId: transferTarget.id,
          memo: form.memo,
        };
        if (form.categoryId !== '') body.categoryId = form.categoryId;
        result = await apiSend('POST', '/api/transactions', body);
      } else {
        const body: CreateTransactionRequest = {
          accountId: account.id,
          date: form.date,
          amount,
          payeeName: form.payeeName,
          memo: form.memo,
        };
        if (splits !== undefined) body.splits = splits;
        else body.categoryId = form.categoryId === '' ? null : form.categoryId;
        result = await apiSend('POST', '/api/transactions', body);
      }
      if (result === null) return; // user declined the reconciled-edit confirm
      onBalances(result.accountBalances);
      setForm({ ...emptyForm(), date: form.date }); // keep the date for rapid entry
      await Promise.all([reload(), reloadPayees()]);
      dateRef.current?.focus();
    } catch (err) {
      setError(describeError(err));
    }
  };

  const remove = async (id: string): Promise<void> => {
    setError(null);
    try {
      const result = await withForceRetry((forceQuery) =>
        apiSend<DeleteTransactionResponse>('DELETE', `/api/transactions/${id}${forceQuery}`),
      );
      if (result === null) return;
      onBalances(result.accountBalances);
      if (form.editingId === id) setForm(emptyForm());
      await reload();
    } catch (err) {
      setError(describeError(err));
    }
  };

  // S6 AC-1/AC-4: the toggle is a real button (keyboard operable) and the
  // balances move in the same round trip.
  const toggleStatus = async (t: TransactionResponse): Promise<void> => {
    setError(null);
    const next = t.status === 'uncleared' ? 'cleared' : 'uncleared';
    try {
      const result = await withForceRetry((forceQuery) =>
        apiSend<TransactionMutationResponse>('PATCH', `/api/transactions/${t.id}${forceQuery}`, {
          status: next,
        } satisfies UpdateTransactionRequest),
      );
      if (result === null) return;
      onBalances(result.accountBalances);
      await reload();
    } catch (err) {
      setError(describeError(err));
    }
  };

  const finishReconcile = async (): Promise<void> => {
    setError(null);
    try {
      const result = await apiSend<ReconcileAccountResponse>(
        'POST',
        `/api/accounts/${account.id}/reconcile`,
        { bankBalance: bankBalance.trim() } satisfies ReconcileAccountRequest,
      );
      onBalances(result.accountBalances);
      setReconcileNote(
        result.adjustmentTransaction
          ? `Reconciled: adjustment of ${formatDollars(result.adjustmentTransaction.amountMilliunits)} created; ${String(result.reconciledCount)} transaction(s) locked.`
          : `Reconciled: ${String(result.reconciledCount)} transaction(s) locked; no adjustment needed.`,
      );
      setReconcileOpen(false);
      setBankBalance('');
      await reload();
    } catch (err) {
      setError(describeError(err));
    }
  };

  const loadMore = async (): Promise<void> => {
    if (!page) return;
    const next = await apiGet<RegisterResponse>(
      registerUrl(page.transactions.length + extraRows.length),
    );
    setExtraRows((rows) => [...rows, ...next.transactions]);
  };

  const toggleClosed = async (): Promise<void> => {
    await apiSend('PATCH', `/api/accounts/${account.id}`, { closed: !account.closed });
    onAccountChanged();
  };

  // E4.S1: OFX/QFX/CSV upload into THIS account (the user's explicit choice —
  // files carry no reliable account mapping, S1 AC-6).
  const importFile = async (file: File): Promise<void> => {
    setError(null);
    setImportNote(null);
    try {
      const result = await apiUpload<ImportFileResponse>(
        `/api/accounts/${account.id}/import`,
        file,
      );
      const parts = [
        `${String(result.createdCount)} new for review`,
        result.mergedCount > 0 ? `${String(result.mergedCount)} matched to existing` : '',
        result.duplicateCount > 0 ? `${String(result.duplicateCount)} already imported` : '',
        result.rejectedCount > 0 ? `${String(result.rejectedCount)} previously rejected` : '',
        result.errors.length > 0
          ? `${String(result.errors.length)} row(s) skipped: ${result.errors
              .map((e) => `line ${String(e.line)} (${e.reason})`)
              .join('; ')}`
          : '',
      ].filter((p) => p !== '');
      setImportNote(`Imported ${file.name} (${result.format.toUpperCase()}): ${parts.join(' · ')}.`);
      onBalances(result.accountBalances);
      onImported();
      await Promise.all([reload(), reloadPayees()]);
    } catch (err) {
      setError(describeError(err));
    }
  };

  // E4.S3 AC-3: unmatch is right on the merged row, not buried in a menu.
  const unmatch = async (id: string): Promise<void> => {
    setError(null);
    try {
      const result = await apiSend<UnmatchTransactionResponse>(
        'POST',
        `/api/transactions/${id}/unmatch`,
      );
      onBalances(result.accountBalances);
      onImported();
      await reload();
    } catch (err) {
      setError(describeError(err));
    }
  };

  const setLine = (index: number, patch: Partial<SplitLineForm>): void => {
    setForm((f) => ({
      ...f,
      splits: f.splits?.map((line, i) => (i === index ? { ...line, ...patch } : line)) ?? null,
    }));
  };

  const rows = page ? [...page.transactions, ...extraRows] : [];
  const unclearedRows = rows.filter((t) => t.status === 'uncleared');

  // Split editor remaining figure, all integer milliunits (ADR-004).
  const splitRemaining = useMemo((): number | null => {
    if (form.splits === null) return null;
    const total = tryParse(form.outflow.trim() !== '' ? form.outflow : form.inflow);
    if (total === null) return null;
    let assigned = 0;
    for (const line of form.splits) {
      const value = tryParse(line.amount);
      if (value === null) return null;
      assigned += value;
    }
    return total - assigned; // same orientation as the entry fields
  }, [form.splits, form.outflow, form.inflow]);

  const bankBalanceMilliunits = tryParse(bankBalance);
  const reconcileDifference =
    page && bankBalanceMilliunits !== null
      ? bankBalanceMilliunits - page.clearedBalanceMilliunits
      : null;

  return (
    <section className="register">
      <header className="register-header">
        <div>
          <h1>
            {account.name}
            {account.closed && <span className="closed-badge"> (closed)</span>}
            {!account.onBudget && <span className="tracking-badge"> tracking</span>}
          </h1>
          <button type="button" className="link-button" onClick={() => void toggleClosed()}>
            {account.closed ? 'Reopen account' : 'Close account'}
          </button>{' '}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setReconcileOpen((open) => !open);
              setReconcileNote(null);
            }}
          >
            {reconcileOpen ? 'Cancel reconciliation' : 'Reconcile'}
          </button>{' '}
          <button type="button" className="link-button" onClick={() => fileRef.current?.click()}>
            Import file…
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".ofx,.qfx,.csv"
            style={{ display: 'none' }}
            aria-label="Import OFX, QFX, or CSV file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = ''; // same file again should re-trigger
              if (file) void importFile(file);
            }}
          />
        </div>
        {page && (
          <dl className="balances">
            <div>
              <dt>Cleared</dt>
              <dd>{formatDollars(page.clearedBalanceMilliunits)}</dd>
            </div>
            <div>
              <dt>Uncleared</dt>
              <dd>
                {formatDollars(page.workingBalanceMilliunits - page.clearedBalanceMilliunits)}
              </dd>
            </div>
            <div>
              <dt>Working</dt>
              <dd>{formatDollars(page.workingBalanceMilliunits)}</dd>
            </div>
          </dl>
        )}
      </header>

      {reconcileNote && <p className="status">{reconcileNote}</p>}
      {importNote && <p className="status">{importNote}</p>}

      {reconcileOpen && page && (
        <section className="reconcile-panel" aria-label="Reconcile account">
          <h2>Reconcile {account.name}</h2>
          <p>
            Cleared balance: <strong>{formatDollars(page.clearedBalanceMilliunits)}</strong>
          </p>
          <label>
            Bank&apos;s actual balance{' '}
            <input
              inputMode="decimal"
              placeholder="0.00"
              value={bankBalance}
              onChange={(e) => setBankBalance(e.target.value)}
              aria-label="Bank balance"
            />
          </label>
          {reconcileDifference !== null && (
            <p>
              Difference: <strong>{formatDollars(reconcileDifference)}</strong>
              {reconcileDifference === 0
                ? ' — ready to finish.'
                : ' — finishing creates a balance adjustment for exactly this amount.'}
            </p>
          )}
          {unclearedRows.length > 0 && (
            <div>
              <p>Uncleared transactions (clear what the bank shows):</p>
              <ul className="reconcile-uncleared">
                {unclearedRows.map((t) => (
                  <li key={t.id}>
                    {t.date} · {t.transferAccountName ? `${TRANSFER_PREFIX}${t.transferAccountName}` : (t.payeeName ?? '—')} ·{' '}
                    {formatDollars(t.amountMilliunits)}{' '}
                    <button type="button" onClick={() => void toggleStatus(t)}>
                      Mark cleared
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <button
            type="button"
            disabled={bankBalanceMilliunits === null}
            onClick={() => void finishReconcile()}
          >
            Finish reconciliation
          </button>
        </section>
      )}

      <form
        className="filters"
        onSubmit={(e) => e.preventDefault()}
        aria-label="Filter transactions"
      >
        <input
          type="search"
          placeholder="Search payee or memo…"
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
          aria-label="Search"
        />
        <input
          type="date"
          value={filters.from}
          onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
          aria-label="From date"
        />
        <input
          type="date"
          value={filters.to}
          onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
          aria-label="To date"
        />
        <CategorySelect
          categories={categories}
          value={filters.categoryId}
          onChange={(categoryId) => setFilters((f) => ({ ...f, categoryId }))}
          emptyLabel="All categories"
        />
        {(filters.search || filters.from || filters.to || filters.categoryId) && page && (
          <span className="filter-totals">
            {page.totalCount} match{page.totalCount === 1 ? '' : 'es'} ·{' '}
            {formatDollars(page.filteredTotalMilliunits)}
            <button type="button" className="link-button" onClick={() => setFilters(NO_FILTERS)}>
              Clear
            </button>
          </span>
        )}
      </form>

      <form className="entry-form" onSubmit={(e) => void submit(e)} aria-label="Add transaction">
        <input
          ref={dateRef}
          type="date"
          required
          value={form.date}
          onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
          aria-label="Date"
        />
        <input
          list="payee-options"
          placeholder="Payee or Transfer: Account"
          value={form.payeeName}
          onChange={(e) => onPayeeInput(e.target.value)}
          disabled={form.editingTransfer}
          aria-label="Payee"
        />
        <datalist id="payee-options">
          {payees.map((p) => (
            <option key={p.id} value={p.name} />
          ))}
          {transferTargets.map((a) => (
            <option key={a.id} value={`${TRANSFER_PREFIX}${a.name}`} />
          ))}
        </datalist>
        <CategorySelect
          categories={categories}
          value={form.categoryId}
          onChange={(categoryId) => setForm((f) => ({ ...f, categoryId }))}
          disabled={!account.onBudget || form.splits !== null}
          emptyLabel={
            !account.onBudget ? 'Off-budget' : form.splits !== null ? 'Split' : 'No category'
          }
        />
        <input
          placeholder="Memo"
          value={form.memo}
          onChange={(e) => setForm((f) => ({ ...f, memo: e.target.value }))}
          aria-label="Memo"
        />
        <input
          placeholder="Outflow"
          inputMode="decimal"
          value={form.outflow}
          onChange={(e) => setForm((f) => ({ ...f, outflow: e.target.value, inflow: '' }))}
          aria-label="Outflow"
        />
        <input
          placeholder="Inflow"
          inputMode="decimal"
          value={form.inflow}
          onChange={(e) => setForm((f) => ({ ...f, inflow: e.target.value, outflow: '' }))}
          aria-label="Inflow"
        />
        {account.onBudget && !form.editingTransfer && (
          <button
            type="button"
            onClick={() =>
              setForm((f) => ({
                ...f,
                categoryId: '',
                splits: f.splits === null ? [emptyLine(), emptyLine()] : null,
              }))
            }
          >
            {form.splits === null ? 'Split' : 'Un-split'}
          </button>
        )}
        <button type="submit">{form.editingId ? 'Save' : 'Add'}</button>
        {form.editingId && (
          <button type="button" onClick={() => setForm(emptyForm())}>
            Cancel
          </button>
        )}
        {form.splits !== null && (
          <div className="split-editor" role="group" aria-label="Split lines">
            {form.splits.map((line, i) => (
              <div className="split-line" key={i}>
                <CategorySelect
                  categories={categories}
                  value={line.categoryId}
                  onChange={(categoryId) => setLine(i, { categoryId })}
                  emptyLabel="No category"
                  label={`Line ${String(i + 1)} category`}
                />
                <input
                  placeholder="Line memo"
                  value={line.memo}
                  onChange={(e) => setLine(i, { memo: e.target.value })}
                  aria-label={`Line ${String(i + 1)} memo`}
                />
                <input
                  placeholder="Amount"
                  inputMode="decimal"
                  value={line.amount}
                  onChange={(e) => setLine(i, { amount: e.target.value })}
                  aria-label={`Line ${String(i + 1)} amount`}
                />
                <button
                  type="button"
                  aria-label={`Remove line ${String(i + 1)}`}
                  onClick={() =>
                    setForm((f) => ({
                      ...f,
                      splits: f.splits?.filter((_, j) => j !== i) ?? null,
                    }))
                  }
                >
                  ✕
                </button>
              </div>
            ))}
            <div className="split-line">
              <button
                type="button"
                onClick={() =>
                  setForm((f) => ({ ...f, splits: [...(f.splits ?? []), emptyLine()] }))
                }
              >
                Add line
              </button>
              <span aria-live="polite">
                {splitRemaining === null
                  ? 'Lines must sum to the transaction amount.'
                  : splitRemaining === 0
                    ? 'Lines match the total.'
                    : `Remaining to assign: ${formatDollars(splitRemaining)}`}
              </span>
            </div>
          </div>
        )}
      </form>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <table className="register-table">
        <thead>
          <tr>
            <th>
              <button
                type="button"
                className="sort-button"
                onClick={() => setSort((s) => (s === 'desc' ? 'asc' : 'desc'))}
                aria-label={`Sort by date, currently ${sort === 'desc' ? 'newest first' : 'oldest first'}`}
              >
                Date {sort === 'desc' ? '▾' : '▴'}
              </button>
            </th>
            <th>Payee</th>
            <th>Category</th>
            <th className="memo-col">Memo</th>
            <th className="amount-col">Outflow</th>
            <th className="amount-col">Inflow</th>
            <th>Status</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <Fragment key={t.id}>
              <tr className={t.approved ? '' : 'unapproved'}>
                <td>{t.date}</td>
                <td>
                  {t.isStartingBalance
                    ? 'Starting Balance'
                    : t.transferAccountName
                      ? `${TRANSFER_PREFIX}${t.transferAccountName}`
                      : (t.payeeName ?? '—')}
                </td>
                <td>
                  {t.lines.length > 0 ? (
                    <button
                      type="button"
                      className="link-button"
                      aria-expanded={expandedSplits[t.id] === true}
                      onClick={() =>
                        setExpandedSplits((open) => ({ ...open, [t.id]: open[t.id] !== true }))
                      }
                    >
                      Split ({t.lines.length}) {expandedSplits[t.id] === true ? '▾' : '▸'}
                    </button>
                  ) : (
                    (t.categoryName ?? '—')
                  )}
                </td>
                <td className="memo-col">{t.memo}</td>
                <td className="amount-col">
                  {t.amountMilliunits < 0 ? formatDollars(-t.amountMilliunits) : ''}
                </td>
                <td className="amount-col">
                  {t.amountMilliunits >= 0 ? formatDollars(t.amountMilliunits) : ''}
                </td>
                <td className="status-col">
                  {/* S6 AC-1/AC-4: keyboard-operable cleared toggle; reconciled
                      rows confirm before unlocking (FR-18). */}
                  <button
                    type="button"
                    className={`cleared-dot ${t.status}`}
                    title={`${t.status} — click to toggle`}
                    aria-label={`Status ${t.status}, toggle cleared`}
                    onClick={() => void toggleStatus(t)}
                  >
                    {STATUS_GLYPH[t.status]}
                  </button>
                  {!t.approved && (
                    <span className="approval-badge" title="Awaiting approval">
                      !
                    </span>
                  )}
                </td>
                <td className="actions-col">
                  <button type="button" className="link-button" onClick={() => startEdit(t)}>
                    Edit
                  </button>
                  <button type="button" className="link-button" onClick={() => void remove(t.id)}>
                    Delete
                  </button>
                  {t.hasImportMatch === true && (
                    <button
                      type="button"
                      className="link-button"
                      title="This row was merged with an imported bank transaction — undo the merge"
                      onClick={() => void unmatch(t.id)}
                    >
                      Unmatch
                    </button>
                  )}
                </td>
              </tr>
              {expandedSplits[t.id] === true &&
                t.lines.map((line) => (
                  <tr key={line.id} className="split-line-row">
                    <td />
                    <td className="split-line-label">↳ split line</td>
                    <td>{line.categoryName ?? '—'}</td>
                    <td className="memo-col">{line.memo}</td>
                    <td className="amount-col">
                      {line.amountMilliunits < 0 ? formatDollars(-line.amountMilliunits) : ''}
                    </td>
                    <td className="amount-col">
                      {line.amountMilliunits >= 0 ? formatDollars(line.amountMilliunits) : ''}
                    </td>
                    <td />
                    <td />
                  </tr>
                ))}
            </Fragment>
          ))}
        </tbody>
      </table>
      {page && rows.length < page.totalCount && (
        <button type="button" className="load-more" onClick={() => void loadMore()}>
          Load more ({rows.length} of {page.totalCount})
        </button>
      )}
      {page && page.totalCount === 0 && <p className="sidebar-empty">No transactions match.</p>}
    </section>
  );
}
