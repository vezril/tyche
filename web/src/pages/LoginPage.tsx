import { useState } from 'react';
import { useAuth } from '../auth.js';

/** Login screen (E1.S2 AC-2/AC-3). Plain and functional; polish comes with E3. */
export function LoginPage(): React.JSX.Element {
  const { login } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    void login(password).then((err) => {
      setBusy(false);
      if (err) {
        setError(err);
        setPassword('');
      }
    });
  };

  return (
    <main className="shell">
      <h1>Tyche</h1>
      <form onSubmit={onSubmit} className="auth-form">
        <label>
          Password
          <input
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p className="status error">{error}</p>}
        <button type="submit" disabled={busy || password.length === 0}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
