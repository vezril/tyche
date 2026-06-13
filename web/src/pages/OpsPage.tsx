import { useCallback, useEffect, useState } from 'react';
import type {
  BackupArtifactResponse,
  BackupRunResponse,
  BackupsResponse,
  BootConsistencyResponse,
  ConsistencyCheckResponse,
} from '@tyche/shared';
import { apiGet, apiSend, describeError } from '../api.js';

/**
 * Ops screen (E7): backup now + artifact list (S1, FR-35), CSV export
 * downloads (S2, FR-36), and the NFR-12 consistency check (S4) — the boot
 * run's result as a loud banner when it failed, and an on-demand re-run.
 * Restore and MASTER_KEY management are deliberately CLI/README procedures
 * (they require a stopped app); this screen links the operator to them.
 */

const fmtSize = (bytes: number): string =>
  bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function OpsPage(): React.JSX.Element {
  const [boot, setBoot] = useState<ConsistencyCheckResponse | null>(null);
  const [check, setCheck] = useState<ConsistencyCheckResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [backups, setBackups] = useState<BackupArtifactResponse[] | null>(null);
  const [backingUp, setBackingUp] = useState(false);
  const [lastBackup, setLastBackup] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reloadBackups = useCallback(async (): Promise<void> => {
    const res = await apiGet<BackupsResponse>('/api/admin/backups');
    setBackups(res.backups);
  }, []);

  useEffect(() => {
    apiGet<BootConsistencyResponse>('/api/admin/consistency')
      .then((res) => setBoot(res.boot))
      .catch((err: unknown) => setError(describeError(err)));
    reloadBackups().catch((err: unknown) => setError(describeError(err)));
  }, [reloadBackups]);

  const runBackup = async (): Promise<void> => {
    setBackingUp(true);
    setError(null);
    try {
      const res = await apiSend<BackupRunResponse>('POST', '/api/admin/backup');
      setLastBackup(res.artifact.name);
      await reloadBackups();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBackingUp(false);
    }
  };

  const runCheck = async (): Promise<void> => {
    setChecking(true);
    setError(null);
    try {
      setCheck(await apiSend<ConsistencyCheckResponse>('POST', '/api/admin/consistency/run'));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setChecking(false);
    }
  };

  return (
    <section className="ops" aria-label="Operations">
      <h2>Operations</h2>
      {error && <p className="status error">{error}</p>}

      {/* E7.S4 AC-2: the boot-time check's mismatch is LOUD, never silent. */}
      {boot && !boot.ok && (
        <div className="banner error" role="alert">
          <strong>Money-math consistency check FAILED at boot.</strong> A displayed balance does
          not match its recomputation from raw transactions ({boot.mismatches.length} mismatch
          {boot.mismatches.length === 1 ? '' : 'es'}). Do not trust balances until resolved.
        </div>
      )}

      <section aria-label="Consistency check">
        <h3>Money-math consistency (NFR-12)</h3>
        <p className="status">
          Recomputes every account balance, every category month, and every month&apos;s Ready to
          Assign from raw transactions and assignments via an independent path, then compares
          exactly — to the milliunit.
        </p>
        {boot && (
          <p className="status">
            Boot check ({boot.ranAt}): {boot.ok ? 'passed' : `FAILED — ${String(boot.mismatches.length)} mismatches`}
            {boot.ok ? ` — ${String(boot.checkedAccounts)} accounts, ${String(boot.checkedMonths)} months.` : '.'}
          </p>
        )}
        <button type="button" onClick={() => void runCheck()} disabled={checking}>
          {checking ? 'Checking…' : 'Run consistency check'}
        </button>
        {check &&
          (check.ok ? (
            <p className="status ok">
              Consistency check passed: {check.checkedAccounts} accounts and {check.checkedMonths}{' '}
              months recomputed with zero mismatches (through {check.throughMonth}).
            </p>
          ) : (
            <div className="banner error" role="alert">
              <strong>Consistency check failed.</strong>
              <ul>
                {check.mismatches.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </div>
          ))}
      </section>

      <section aria-label="Backups">
        <h3>Backups (FR-35)</h3>
        <p className="status">
          One artifact per backup: a consistent database snapshot plus manifest, in{' '}
          <code>data/backups/</code>. A daily backup runs automatically; retention keeps the most
          recent. Remember: back up <code>.env</code> (the <code>MASTER_KEY</code>) separately —
          it is never inside the artifact. Restore is a documented one-command CLI procedure (see
          the README ops guide).
        </p>
        <button type="button" onClick={() => void runBackup()} disabled={backingUp}>
          {backingUp ? 'Backing up…' : 'Back up now'}
        </button>
        {lastBackup && <p className="status ok">Backup written: {lastBackup}</p>}
        {backups && backups.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Artifact</th>
                <th>Size</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.name}>
                  <td>{b.name}</td>
                  <td>{fmtSize(b.sizeBytes)}</td>
                  <td>{b.createdAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {backups && backups.length === 0 && <p className="status">No backups yet.</p>}
      </section>

      <section aria-label="CSV export">
        <h3>CSV export (FR-36)</h3>
        <p className="status">
          Your data, hostage-proof: every transaction, and the monthly budget per category. Both
          are plain REST endpoints too (<code>curl</code> with a session cookie works).
        </p>
        <p>
          <a href="/api/export/register.csv" download="register.csv">
            Download register CSV
          </a>
          {' · '}
          <a href="/api/export/budget.csv" download="budget.csv">
            Download budget CSV
          </a>
        </p>
      </section>
    </section>
  );
}
