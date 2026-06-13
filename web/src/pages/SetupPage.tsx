import { useState } from 'react';
import { useAuth } from '../auth.js';

/**
 * One-time first-run setup (E1.S2 AC-1): creates the single account password.
 * The server returns 410 forever after, so this screen is unreachable again.
 * Plain and functional by design — design-system polish lands with E3.
 */
export function SetupPage(): React.JSX.Element {
  const { setup } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    void setup(password).then((err) => {
      setBusy(false);
      if (err) setError(err);
    });
  };

  return (
    <main className="shell">
      <h1>Tyche</h1>
      <p>First-run setup: choose the password that will protect your budget.</p>
      <form onSubmit={onSubmit} className="auth-form">
        <label>
          Password
          <input
            type="password"
            autoFocus
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label>
          Confirm password
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
        {error && <p className="status error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
      </form>
    </main>
  );
}
