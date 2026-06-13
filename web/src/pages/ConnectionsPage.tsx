import { useCallback, useEffect, useState } from 'react';
import type {
  AccountBalancesResponse,
  AccountResponse,
  PlaidItemResponse,
  PlaidItemsResponse,
  PlaidLinkTokenResponse,
  PlaidSyncRunResponse,
  SettingsResponse,
} from '@ynab-clone/shared';
import { apiGet, apiSend, describeError } from '../api.js';
import { loadPlaidLink, type PlaidLinkLoader } from './plaid-link.js';

/**
 * Bank-connection management (E5.S1–S5, FR-20/21/26/27/28): list Items with
 * their institution, state and sync health; start a new link via the Plaid
 * Link widget (the CDN script loads only from here — S1 AC-4); map each
 * discovered bank account to an app account or skip it; manual "sync now"
 * (S2); re-link a broken connection via Link UPDATE MODE (S4 — same Item,
 * cursor and mappings preserved); per-connection sync-health detail (S4
 * AC-3); and unlink with confirmation (S5 — history preserved).
 */

/** The skip choice in the mapping picker — distinct from "no decision yet". */
const SKIP = '__skip__';
const UNMAPPED = '';

interface ConnectionsPageProps {
  accounts: AccountResponse[];
  onBalances(balances: AccountBalancesResponse[]): void;
  /** After a sync lands rows, the shell refreshes the review badge + accounts. */
  onChanged(): void;
  /** Every (re)load reports the Items up so the shell's banner stays fresh (S4). */
  onItems?(items: PlaidItemResponse[]): void;
  /** Set by the shell's banner: start Link update mode for this Item on load (S4 AC-5). */
  relinkItemId?: string | null;
  onRelinkHandled?(): void;
  /** Injectable for tests; defaults to the real CDN loader (ADR-008 carve-out). */
  linkLoader?: PlaidLinkLoader;
}

function pickerValue(accountId: string | null, skipped: boolean): string {
  return skipped ? SKIP : (accountId ?? UNMAPPED);
}

export function ConnectionsPage({
  accounts,
  onBalances,
  onChanged,
  onItems,
  relinkItemId = null,
  onRelinkHandled,
  linkLoader = loadPlaidLink,
}: ConnectionsPageProps): React.JSX.Element {
  const [items, setItems] = useState<PlaidItemResponse[] | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Mapping drafts: itemId → plaidAccountId → picker value. */
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});

  const reload = useCallback(async (): Promise<void> => {
    const [settings, list] = await Promise.all([
      apiGet<SettingsResponse>('/api/settings'),
      apiGet<PlaidItemsResponse>('/api/plaid/items'),
    ]);
    setConfigured(settings.plaid.configured);
    setItems(list.items);
    onItems?.(list.items); // keep the shell's broken-connection banner fresh (S4)
    setDrafts(
      Object.fromEntries(
        list.items.map((item) => [
          item.id,
          Object.fromEntries(
            item.accounts.map((a) => [a.plaidAccountId, pickerValue(a.accountId, a.skipped)]),
          ),
        ]),
      ),
    );
  }, [onItems]);

  useEffect(() => {
    reload().catch((err: unknown) => setError(describeError(err)));
  }, [reload]);

  const addConnection = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      // The link token comes first; only then does the CDN script load (AC-4).
      const { linkToken } = await apiSend<PlaidLinkTokenResponse>('POST', '/api/plaid/link-token');
      const plaid = await linkLoader();
      const handler = plaid.create({
        token: linkToken,
        onSuccess: (publicToken) => {
          void (async () => {
            try {
              await apiSend<PlaidItemResponse>('POST', '/api/plaid/items', { publicToken });
              setNotice('Connected. Map each discovered bank account below, or skip it.');
              await reload();
            } catch (err) {
              setError(describeError(err));
            } finally {
              setBusy(false);
            }
          })();
        },
        onExit: (exitError) => {
          setBusy(false);
          if (exitError) setError(exitError.error_message ?? 'Plaid Link did not complete.');
        },
      });
      handler.open();
    } catch (err) {
      setBusy(false);
      setError(describeError(err));
    }
  };

  const saveMappings = async (item: PlaidItemResponse): Promise<void> => {
    setError(null);
    setNotice(null);
    const draft = drafts[item.id] ?? {};
    try {
      await apiSend<PlaidItemResponse>('PUT', `/api/plaid/items/${item.id}/mappings`, {
        mappings: item.accounts.map((a) => {
          const value = draft[a.plaidAccountId] ?? UNMAPPED;
          return {
            plaidAccountId: a.plaidAccountId,
            accountId: value === SKIP || value === UNMAPPED ? null : value,
            skipped: value === SKIP,
          };
        }),
      });
      setNotice('Mapping saved.');
      await reload();
    } catch (err) {
      setError(describeError(err));
    }
  };

  const syncNow = async (item: PlaidItemResponse): Promise<void> => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const result = await apiSend<PlaidSyncRunResponse>('POST', `/api/plaid/items/${item.id}/sync`);
      const removed = result.removedVoidedCount + result.removedFlaggedCount;
      setNotice(
        `Synced ${item.institutionName ?? 'connection'}: ${String(result.addedCount)} new, ` +
          `${String(result.mergedCount)} matched, ${String(result.updatedCount)} updated, ` +
          `${String(removed)} removed.`,
      );
      onBalances(result.accountBalances);
      onChanged();
      await reload();
    } catch (err) {
      setError(describeError(err));
      // The failure may have flipped the Item to NEEDS_RELINK (S4 AC-1) —
      // refresh so the state badge and the shell banner reflect it.
      await reload().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  // --- S4 AC-2/AC-5: re-link a broken connection via Link UPDATE MODE -------
  // The token is minted against the Item's own access token, so Link repairs
  // the SAME Item: no public-token exchange, no re-mapping, cursor preserved.
  const relink = async (item: PlaidItemResponse): Promise<void> => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const { linkToken } = await apiSend<PlaidLinkTokenResponse>(
        'POST',
        `/api/plaid/items/${item.id}/relink-token`,
      );
      const plaid = await linkLoader();
      const handler = plaid.create({
        token: linkToken,
        onSuccess: () => {
          void (async () => {
            try {
              await apiSend<PlaidItemResponse>('POST', `/api/plaid/items/${item.id}/relinked`);
              setNotice(
                `${item.institutionName ?? 'Connection'} re-linked. Sync resumes where it left off.`,
              );
              await reload();
            } catch (err) {
              setError(describeError(err));
            } finally {
              setBusy(false);
            }
          })();
        },
        onExit: (exitError) => {
          setBusy(false);
          if (exitError) setError(exitError.error_message ?? 'Plaid Link did not complete.');
        },
      });
      handler.open();
    } catch (err) {
      setBusy(false);
      setError(describeError(err));
    }
  };

  // The shell's banner lands here with an Item to repair: start update mode
  // as soon as the list is loaded (S4 AC-5 — the banner links DIRECTLY to it).
  useEffect(() => {
    if (relinkItemId === null || items === null) return;
    const target = items.find((i) => i.id === relinkItemId);
    onRelinkHandled?.();
    if (target && target.status === 'NEEDS_RELINK') void relink(target);
    // deliberately NOT keyed on `items`/`relink`: one start per handoff, once loaded
  }, [relinkItemId, items === null]);

  // --- S5: unlink — revoke + stop syncing, KEEP imported history (FR-28) ----
  const unlink = async (item: PlaidItemResponse): Promise<void> => {
    const name = item.institutionName ?? 'this connection';
    if (
      !window.confirm(
        `Unlink ${name}? The app's access to the bank is revoked and syncing stops. ` +
          'Every transaction already imported stays in your register.',
      )
    ) {
      return;
    }
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await apiSend<PlaidItemResponse>('POST', `/api/plaid/items/${item.id}/unlink`);
      setNotice(`${name} unlinked. Imported transactions were kept.`);
      await reload();
      onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const openAccounts = accounts.filter((a) => !a.closed);

  return (
    <section className="connections" aria-label="Bank connections">
      <h1>Bank connections</h1>
      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="status">{notice}</p>}

      {configured === false && (
        <p className="status">
          Plaid is not configured yet — add your client id and secret under Settings first.
        </p>
      )}
      {configured === true && (
        <p>
          <button type="button" disabled={busy} onClick={() => void addConnection()}>
            Add bank connection
          </button>
        </p>
      )}

      {items?.length === 0 && configured === true && (
        <p className="status">No connections yet. Link your bank to start syncing transactions.</p>
      )}

      {items?.map((item) => (
        <section key={item.id} className="connection" aria-label={item.institutionName ?? 'Connection'}>
          <h2>
            {item.institutionName ?? 'Unknown institution'}{' '}
            <span className={`connection-state state-${item.status.toLowerCase()}`}>{item.status}</span>
          </h2>
          {/* S4 AC-3 (FR-27): last attempt, last success, recent outcomes. */}
          <p className="connection-health">
            {item.lastSuccessAt
              ? `Last successful sync: ${item.lastSuccessAt}`
              : 'Never synced successfully.'}{' '}
            {item.lastAttempt && `Last attempt: ${item.lastAttempt.at}.`}
            {item.lastAttempt?.outcome === 'error' && (
              <span className="status error">
                {' '}
                Last attempt failed{item.lastAttempt.errorCode ? ` (${item.lastAttempt.errorCode})` : ''}.
              </span>
            )}
          </p>
          <table className="connection-accounts">
            <thead>
              <tr>
                <th scope="col">Bank account</th>
                <th scope="col">Maps to</th>
              </tr>
            </thead>
            <tbody>
              {item.accounts.map((bank) => (
                <tr key={bank.plaidAccountId}>
                  <td>
                    {bank.name}
                    {bank.mask && <span className="connection-mask"> •• {bank.mask}</span>}
                  </td>
                  <td>
                    {item.status === 'UNLINKED' ? (
                      // S5 AC-4: the unlinked record stays visible for audit,
                      // read-only — mappings are history now, not choices.
                      (bank.accountName ?? (bank.skipped ? 'Skipped' : 'Not mapped'))
                    ) : (
                      <select
                        aria-label={`Map ${bank.name}`}
                        value={drafts[item.id]?.[bank.plaidAccountId] ?? UNMAPPED}
                        onChange={(e) =>
                          setDrafts((d) => ({
                            ...d,
                            [item.id]: { ...d[item.id], [bank.plaidAccountId]: e.target.value },
                          }))
                        }
                      >
                        <option value={UNMAPPED}>Not mapped</option>
                        <option value={SKIP}>Skip (never import)</option>
                        {openAccounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {item.status !== 'UNLINKED' && (
            <p className="connection-actions">
              <button type="button" onClick={() => void saveMappings(item)}>
                Save mapping
              </button>
              <button
                type="button"
                disabled={busy || item.status !== 'ACTIVE'}
                onClick={() => void syncNow(item)}
              >
                Sync now
              </button>
              {item.status === 'NEEDS_RELINK' && (
                <button type="button" disabled={busy} onClick={() => void relink(item)}>
                  Re-link
                </button>
              )}
              <button
                type="button"
                className="connection-unlink"
                disabled={busy}
                onClick={() => void unlink(item)}
              >
                Unlink…
              </button>
            </p>
          )}
          {/* S4 AC-3: per-connection sync-health detail — recent attempts. */}
          <details className="connection-log">
            <summary>Sync history</summary>
            {item.syncLog.length === 0 ? (
              <p className="status">No sync attempts yet.</p>
            ) : (
              <table className="connection-log-table">
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Outcome</th>
                    <th scope="col">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {item.syncLog.map((entry, i) => (
                    <tr key={`${entry.at}-${String(i)}`}>
                      <td>{entry.at}</td>
                      <td>
                        {entry.outcome === 'success' ? (
                          'OK'
                        ) : (
                          <span className="status error">failed</span>
                        )}
                      </td>
                      <td>
                        {entry.outcome === 'success'
                          ? `${String(entry.addedCount)} added, ${String(entry.updatedCount)} updated, ${String(entry.removedCount)} removed`
                          : (entry.errorCode ?? entry.message ?? 'unknown error')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </details>
        </section>
      ))}
    </section>
  );
}
