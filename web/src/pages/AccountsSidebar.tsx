import { useState } from 'react';
import {
  formatMilliunits,
  milliunits,
  type AccountResponse,
  type AccountType,
  type CreateAccountRequest,
} from '@ynab-clone/shared';
import { apiSend, describeError } from '../api.js';

/**
 * Accounts sidebar (E2.S1): active accounts with working balances, a
 * collapsed closed-accounts section, and the create-account form (FR-11/12).
 */

export function formatDollars(amountMilliunits: number): string {
  return `$${formatMilliunits(milliunits(amountMilliunits))}`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  chequing: 'Chequing (on-budget)',
  savings: 'Savings (on-budget)',
  tracking: 'Tracking (off-budget)',
};

function AddAccountForm({ onCreated }: { onCreated: (account: AccountResponse) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountType>('chequing');
  const [startingBalance, setStartingBalance] = useState('0.00');
  const [startingDate, setStartingDate] = useState(today());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button type="button" className="sidebar-add" onClick={() => setOpen(true)}>
        + Add account
      </button>
    );
  }

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: CreateAccountRequest = { name, type, startingBalance, startingDate };
      const account = await apiSend<AccountResponse>('POST', '/api/accounts', body);
      setOpen(false);
      setName('');
      setStartingBalance('0.00');
      onCreated(account);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="add-account-form" onSubmit={(e) => void submit(e)}>
      <label>
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={200}
          autoFocus
        />
      </label>
      <label>
        Type
        <select value={type} onChange={(e) => setType(e.target.value as AccountType)}>
          {(Object.keys(ACCOUNT_TYPE_LABELS) as AccountType[]).map((t) => (
            <option key={t} value={t}>
              {ACCOUNT_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Starting balance
        <input
          value={startingBalance}
          onChange={(e) => setStartingBalance(e.target.value)}
          inputMode="decimal"
          required
        />
      </label>
      <label>
        As of
        <input
          type="date"
          value={startingDate}
          onChange={(e) => setStartingDate(e.target.value)}
          required
        />
      </label>
      {error && <p className="form-error">{error}</p>}
      <div className="form-row">
        <button type="submit" disabled={busy}>
          Create
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function AccountsSidebar({
  accounts,
  selectedId,
  onSelect,
  onCreated,
}: {
  accounts: AccountResponse[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreated: (account: AccountResponse) => void;
}): React.JSX.Element {
  const [showClosed, setShowClosed] = useState(false);
  const open = accounts.filter((a) => !a.closed);
  const closed = accounts.filter((a) => a.closed);
  const onBudget = open.filter((a) => a.onBudget);
  const tracking = open.filter((a) => !a.onBudget);

  const item = (account: AccountResponse): React.JSX.Element => (
    <li key={account.id}>
      <button
        type="button"
        className={`account-item${account.id === selectedId ? ' selected' : ''}`}
        onClick={() => onSelect(account.id)}
      >
        <span className="account-name">{account.name}</span>
        <span className={`account-balance${account.workingBalanceMilliunits < 0 ? ' negative' : ''}`}>
          {formatDollars(account.workingBalanceMilliunits)}
        </span>
      </button>
    </li>
  );

  return (
    <nav className="sidebar" aria-label="Accounts">
      {onBudget.length > 0 && (
        <>
          <h2>Budget accounts</h2>
          <ul>{onBudget.map(item)}</ul>
        </>
      )}
      {tracking.length > 0 && (
        <>
          <h2>Tracking accounts</h2>
          <ul>{tracking.map(item)}</ul>
        </>
      )}
      {open.length === 0 && <p className="sidebar-empty">No accounts yet.</p>}
      <AddAccountForm onCreated={onCreated} />
      {closed.length > 0 && (
        <>
          <button
            type="button"
            className="sidebar-add"
            aria-expanded={showClosed}
            onClick={() => setShowClosed((s) => !s)}
          >
            {showClosed ? '▾' : '▸'} Closed accounts ({closed.length})
          </button>
          {showClosed && <ul className="closed-list">{closed.map(item)}</ul>}
        </>
      )}
    </nav>
  );
}
