import { useState } from 'react';
import { formatMilliunits, milliunits, type MigrationResponse } from '@ynab-clone/shared';
import { apiUploadFiles, describeError } from '../api.js';

/**
 * YNAB migration screen (E6, FR-30/31): upload the two CSVs from YNAB's
 * export zip (Register + Plan), run the one-shot migration into the empty
 * budget, and show the proof — the to-the-cent parity report per account and
 * per category, the discrepancy report (anything that could not be mapped,
 * never silently dropped), and the NFR-12 consistency check result.
 */

const fmt = (amount: number): string => `$${formatMilliunits(milliunits(amount))}`;

export interface MigrationPageProps {
  /** Refresh accounts/categories/budget after a successful migration. */
  onMigrated: () => void;
}

export function MigrationPage({ onMigrated }: MigrationPageProps): React.JSX.Element {
  const [registerFile, setRegisterFile] = useState<File | null>(null);
  const [planFile, setPlanFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MigrationResponse | null>(null);

  const run = async (): Promise<void> => {
    if (!registerFile || !planFile) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiUploadFiles<MigrationResponse>('/api/migration', {
        register: registerFile,
        plan: planFile,
      });
      setResult(res);
      onMigrated();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="migration" aria-label="YNAB migration">
      <h2>Migrate from YNAB</h2>
      <p className="status">
        Upload both CSVs from YNAB&apos;s export (Plan &rarr; Export plan): the{' '}
        <strong>Register</strong> file (full transaction history) and the <strong>Plan</strong>{' '}
        file (budgeted amounts per month). Migration runs once, into an empty budget, and proves
        the result against the export to the cent.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <label>
          Register CSV
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => setRegisterFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <label>
          Plan CSV
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => setPlanFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <button type="submit" disabled={busy || !registerFile || !planFile}>
          {busy ? 'Migrating…' : 'Run migration'}
        </button>
      </form>

      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}

      {result && (
        <section className="migration-result" aria-label="Migration result">
          <h3>
            Migration complete —{' '}
            {result.parity.ok && result.consistency.ok ? (
              <span className="parity-ok">parity verified to the cent</span>
            ) : (
              <span className="status error">parity check FAILED — review below</span>
            )}
          </h3>
          <p className="status">
            {result.accountCount} accounts · {result.categoryGroupCount} groups ·{' '}
            {result.categoryCount} categories · {result.payeeCount} payees ·{' '}
            {result.transactionCount} transactions ({result.transferCount} transfers,{' '}
            {result.splitCount} splits) · {result.assignmentCount} monthly assignments
          </p>

          <h4>Account balances vs YNAB</h4>
          <table className="migration-parity">
            <thead>
              <tr>
                <th>Account</th>
                <th>YNAB</th>
                <th>Imported</th>
                <th>Match</th>
              </tr>
            </thead>
            <tbody>
              {result.parity.accounts.map((a) => (
                <tr key={a.accountName}>
                  <td>{a.accountName}</td>
                  <td>{fmt(a.sourceBalanceMilliunits)}</td>
                  <td>{fmt(a.importedBalanceMilliunits)}</td>
                  <td>{a.ok ? 'OK' : <span className="status error">MISMATCH</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h4>
            Category available ({result.parity.month}) vs YNAB —{' '}
            {result.parity.categories.filter((c) => c.ok).length}/{result.parity.categories.length}{' '}
            match
          </h4>
          <table className="migration-parity">
            <thead>
              <tr>
                <th>Category</th>
                <th>YNAB</th>
                <th>Computed</th>
                <th>Match</th>
              </tr>
            </thead>
            <tbody>
              {result.parity.categories.map((c) => (
                <tr key={`${c.groupName}:${c.categoryName}`}>
                  <td>
                    {c.groupName}: {c.categoryName}
                  </td>
                  <td>{fmt(c.sourceAvailableMilliunits)}</td>
                  <td>{fmt(c.computedAvailableMilliunits)}</td>
                  <td>{c.ok ? 'OK' : <span className="status error">MISMATCH</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h4>Discrepancy report ({result.discrepancies.length})</h4>
          {result.discrepancies.length === 0 ? (
            <p className="status">Every source row mapped cleanly.</p>
          ) : (
            <ul className="migration-discrepancies">
              {result.discrepancies.map((d, index) => (
                <li key={index}>
                  [{d.source}
                  {d.line !== null ? ` line ${String(d.line)}` : ''}] {d.reason}
                </li>
              ))}
            </ul>
          )}

          <h4>Consistency check (NFR-12)</h4>
          {result.consistency.ok ? (
            <p className="status">Passed — SQL aggregation and raw-row recompute agree.</p>
          ) : (
            <ul className="status error">
              {result.consistency.mismatches.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
        </section>
      )}
    </section>
  );
}
