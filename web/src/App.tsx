import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import type {
  AccountBalancesResponse,
  AccountResponse,
  AccountsResponse,
  CategoriesResponse,
  CategorySummary,
  PlaidItemResponse,
  PlaidItemsResponse,
  ReviewQueueResponse,
} from '@ynab-clone/shared';
import { apiGet } from './api.js';
import { RequireAuth, useAuth } from './auth.js';
import { LoginPage } from './pages/LoginPage.js';
import { SetupPage } from './pages/SetupPage.js';
import { AccountsSidebar } from './pages/AccountsSidebar.js';
import { RegisterPage } from './pages/RegisterPage.js';
import { CategoriesPage } from './pages/CategoriesPage.js';
import { ReviewPage } from './pages/ReviewPage.js';
import { SyncBanner } from './pages/SyncBanner.js';

// Code-split per ADR-008/E3.S2 dev notes: the grid bundle loads on demand.
const BudgetPage = lazy(() => import('./pages/BudgetPage.js'));
// Code-split per ADR-008's Plaid carve-out (E5.S1 AC-4): even the Link LOADER
// code ships only with the connections screen's chunk; the CDN script itself
// loads only when a link flow starts there.
const ConnectionsPage = lazy(() =>
  import('./pages/ConnectionsPage.js').then((m) => ({ default: m.ConnectionsPage })),
);
// Code-split: the YNAB migration screen (E6) is a one-shot setup surface.
const MigrationPage = lazy(() =>
  import('./pages/MigrationPage.js').then((m) => ({ default: m.MigrationPage })),
);
// Code-split: the ops screen (E7 — backup, export, consistency) is rare-use.
const OpsPage = lazy(() => import('./pages/OpsPage.js').then((m) => ({ default: m.OpsPage })));

type View = 'budget' | 'accounts' | 'review' | 'categories' | 'connections' | 'migration' | 'ops';

/**
 * App shell: the budget month grid (E3.S2, the product surface), the accounts
 * sidebar + per-account register (E2), the category management screen
 * (E3.S6), and the bank connections screen (E5), switched by a top-level nav.
 * The broken-connection banner (E5.S4, FR-26) renders HERE so it is visible
 * on every view, not just the connections screen. Exported for the shell-
 * level banner test.
 */
export function Shell(): React.JSX.Element {
  const { logout } = useAuth();
  const [view, setView] = useState<View>('budget');
  const [accounts, setAccounts] = useState<AccountResponse[] | null>(null);
  const [categories, setCategories] = useState<CategorySummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reloadAccounts = useCallback(async (): Promise<void> => {
    const res = await apiGet<AccountsResponse>('/api/accounts?includeClosed=true');
    setAccounts(res.accounts);
    setSelectedId((id) => id ?? res.accounts.find((a) => !a.closed)?.id ?? null);
  }, []);

  // Also re-run after E3.S6 structure edits so pickers update immediately (AC-1).
  const reloadCategories = useCallback(async (): Promise<void> => {
    const res = await apiGet<CategoriesResponse>('/api/categories');
    setCategories(res.categories);
  }, []);

  // E4.S2 AC-1: the queue size rides on the nav as a badge, refreshed after
  // every import / review action.
  const [reviewCount, setReviewCount] = useState(0);
  const reloadReview = useCallback(async (): Promise<void> => {
    const res = await apiGet<ReviewQueueResponse>('/api/review');
    setReviewCount(res.totalCount);
  }, []);

  // E5.S4 (FR-26): connection states feed the app-wide broken-connection
  // banner. Loaded once at mount and kept fresh by the connections screen
  // (every reload there reports back via onItems).
  const [plaidItems, setPlaidItems] = useState<PlaidItemResponse[]>([]);
  const reloadConnections = useCallback(async (): Promise<void> => {
    const res = await apiGet<PlaidItemsResponse>('/api/plaid/items');
    setPlaidItems(res.items);
  }, []);
  /** Banner → connections screen handoff: start update mode for this Item. */
  const [relinkItemId, setRelinkItemId] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([reloadAccounts(), reloadCategories(), reloadReview(), reloadConnections()]).catch(
      (e: unknown) => setError(String(e)),
    );
  }, [reloadAccounts, reloadCategories, reloadReview, reloadConnections]);

  // Mutations return recomputed balances (ADR-005/008): patch them straight
  // into the sidebar instead of refetching the whole account list.
  const applyBalances = useCallback((balances: AccountBalancesResponse[]): void => {
    setAccounts(
      (list) =>
        list &&
        list.map((a) => {
          const updated = balances.find((b) => b.accountId === a.id);
          return updated
            ? {
                ...a,
                workingBalanceMilliunits: updated.workingBalanceMilliunits,
                clearedBalanceMilliunits: updated.clearedBalanceMilliunits,
              }
            : a;
        }),
    );
  }, []);

  const selected = accounts?.find((a) => a.id === selectedId) ?? null;

  return (
    <div className="app">
      <header className="app-header">
        <h1>ynab-clone</h1>
        <nav className="app-nav" aria-label="Main">
          <button
            type="button"
            className={view === 'budget' ? 'active' : ''}
            aria-current={view === 'budget' ? 'page' : undefined}
            onClick={() => setView('budget')}
          >
            Budget
          </button>
          <button
            type="button"
            className={view === 'accounts' ? 'active' : ''}
            aria-current={view === 'accounts' ? 'page' : undefined}
            onClick={() => setView('accounts')}
          >
            Accounts
          </button>
          <button
            type="button"
            className={view === 'review' ? 'active' : ''}
            aria-current={view === 'review' ? 'page' : undefined}
            onClick={() => setView('review')}
          >
            Review
            {reviewCount > 0 && (
              <span className="review-badge" aria-label={`${String(reviewCount)} awaiting review`}>
                {reviewCount}
              </span>
            )}
          </button>
          <button
            type="button"
            className={view === 'categories' ? 'active' : ''}
            aria-current={view === 'categories' ? 'page' : undefined}
            onClick={() => setView('categories')}
          >
            Categories
          </button>
          <button
            type="button"
            className={view === 'connections' ? 'active' : ''}
            aria-current={view === 'connections' ? 'page' : undefined}
            onClick={() => setView('connections')}
          >
            Connections
          </button>
          <button
            type="button"
            className={view === 'migration' ? 'active' : ''}
            aria-current={view === 'migration' ? 'page' : undefined}
            onClick={() => setView('migration')}
          >
            Migration
          </button>
          <button
            type="button"
            className={view === 'ops' ? 'active' : ''}
            aria-current={view === 'ops' ? 'page' : undefined}
            onClick={() => setView('ops')}
          >
            Ops
          </button>
        </nav>
        <button type="button" onClick={() => void logout()}>
          Sign out
        </button>
      </header>
      {error && <p className="status error">API unreachable: {error}</p>}
      {/* E5.S4 AC-1/AC-5: visible on EVERY view, links straight to re-link. */}
      <SyncBanner
        items={plaidItems}
        onRelink={(itemId) => {
          setRelinkItemId(itemId);
          setView('connections');
        }}
      />
      {view === 'budget' ? (
        <main className="app-main">
          <Suspense fallback={<p className="status">Loading budget…</p>}>
            <BudgetPage />
          </Suspense>
        </main>
      ) : view === 'review' ? (
        <main className="app-main">
          <ReviewPage
            categories={categories}
            onBalances={applyBalances}
            onChanged={() => void reloadReview()}
          />
        </main>
      ) : view === 'categories' ? (
        <main className="app-main">
          <CategoriesPage onChanged={() => void reloadCategories()} />
        </main>
      ) : view === 'ops' ? (
        <main className="app-main">
          <Suspense fallback={<p className="status">Loading ops…</p>}>
            <OpsPage />
          </Suspense>
        </main>
      ) : view === 'migration' ? (
        <main className="app-main">
          <Suspense fallback={<p className="status">Loading migration…</p>}>
            <MigrationPage
              onMigrated={() => {
                void reloadAccounts();
                void reloadCategories();
                void reloadReview();
              }}
            />
          </Suspense>
        </main>
      ) : view === 'connections' ? (
        <main className="app-main">
          <Suspense fallback={<p className="status">Loading connections…</p>}>
            <ConnectionsPage
              accounts={accounts ?? []}
              onBalances={applyBalances}
              onChanged={() => {
                void reloadReview();
                void reloadAccounts();
              }}
              onItems={setPlaidItems}
              relinkItemId={relinkItemId}
              onRelinkHandled={() => setRelinkItemId(null)}
            />
          </Suspense>
        </main>
      ) : (
        <div className="app-body">
          <AccountsSidebar
            accounts={accounts ?? []}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onCreated={(account) => {
              setSelectedId(account.id);
              void reloadAccounts();
            }}
          />
          <main className="app-main">
            {selected ? (
              <RegisterPage
                key={selected.id}
                account={selected}
                accounts={accounts ?? []}
                categories={categories}
                onBalances={applyBalances}
                onAccountChanged={() => void reloadAccounts()}
                onImported={() => void reloadReview()}
              />
            ) : accounts && accounts.length === 0 ? (
              <section className="register">
                <h1>Welcome</h1>
                <p>Create your first account to start the ledger.</p>
              </section>
            ) : null}
          </main>
        </div>
      )}
    </div>
  );
}

export function App(): React.JSX.Element {
  return (
    <RequireAuth setupScreen={<SetupPage />} loginScreen={<LoginPage />}>
      <Shell />
    </RequireAuth>
  );
}
