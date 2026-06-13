import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { CSRF_HEADER, type AuthStatusResponse } from '@tyche/shared';

/**
 * Auth context + route guard for the SPA (E1.S2, AC-2).
 *
 * On load it asks /api/auth/status (allowlisted server-side) which screen to
 * show: first-run setup, login, or the app. Every mutation goes through
 * `mutate()` so the custom CSRF header (AC-6) is never forgotten.
 */

export type AuthState = 'loading' | 'setup-required' | 'unauthenticated' | 'authenticated';

interface AuthContextValue {
  state: AuthState;
  /** Returns an error message to display, or null on success. */
  setup(password: string): Promise<string | null>;
  /** Returns an error message to display, or null on success. */
  login(password: string): Promise<string | null>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** POST with the custom CSRF header required on every mutation (AC-6). */
async function mutate(url: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
    body: body === undefined ? null : JSON.stringify(body),
  });
}

async function errorMessage(res: Response): Promise<string> {
  if (res.status === 401) return 'Wrong password.';
  if (res.status === 429) {
    const body = (await res.json().catch(() => ({}))) as { retryAfterSeconds?: number };
    const secs = body.retryAfterSeconds ?? 60;
    return `Too many failed attempts — locked out. Try again in ${secs}s.`;
  }
  if (res.status === 400) return 'Password must be at least 8 characters.';
  return `Unexpected error (${res.status}).`;
}

export function AuthProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [state, setState] = useState<AuthState>('loading');

  useEffect(() => {
    fetch('/api/auth/status')
      .then((r) => r.json() as Promise<AuthStatusResponse>)
      .then((s) =>
        setState(
          s.setupRequired ? 'setup-required' : s.authenticated ? 'authenticated' : 'unauthenticated',
        ),
      )
      .catch(() => setState('unauthenticated'));
  }, []);

  const setup = useCallback(async (password: string): Promise<string | null> => {
    const res = await mutate('/api/auth/setup', { password });
    if (!res.ok) return errorMessage(res);
    setState('authenticated');
    return null;
  }, []);

  const login = useCallback(async (password: string): Promise<string | null> => {
    const res = await mutate('/api/auth/login', { password });
    if (!res.ok) return errorMessage(res);
    setState('authenticated');
    return null;
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    await mutate('/api/auth/logout');
    setState('unauthenticated');
  }, []);

  return (
    <AuthContext.Provider value={{ state, setup, login, logout }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/**
 * Route guard (AC-2): renders setup or login until a session exists; only an
 * authenticated state ever mounts the app — no budget UI without a session.
 */
export function RequireAuth({
  setupScreen,
  loginScreen,
  children,
}: {
  setupScreen: React.ReactNode;
  loginScreen: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  const { state } = useAuth();
  if (state === 'loading') return <main className="shell">Checking session…</main>;
  if (state === 'setup-required') return <>{setupScreen}</>;
  if (state === 'unauthenticated') return <>{loginScreen}</>;
  return <>{children}</>;
}
