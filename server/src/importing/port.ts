import type { Milliunits } from '@tyche/shared';

/**
 * The importer port (ADR-006): every backend — file upload (E4, this epic),
 * Plaid sync (E5), YNAB migration (E6) — reduces its input to the SAME staged
 * shape, and everything downstream (normalize → dedup/match → review queue →
 * ledger write) is shared and backend-agnostic. Cross-source dedup (FR-23)
 * only works because no backend writes the ledger itself.
 *
 * What E5 (Plaid) must know about this seam:
 *  - Emit one StagedTransaction per Plaid `added` transaction with
 *    `externalId = transaction_id`; run them through `runImport()` from
 *    pipeline.ts with `source: 'plaid'` — T1/T2/T3 then behave identically to
 *    file import (S3 AC-6).
 *  - T1 currently treats an already-seen external id as a SKIP. Plaid
 *    `modified` entries (pending→posted updates) need T1 "apply as update" —
 *    extend the T1 branch in pipeline.ts, do not write rows directly.
 *  - Plaid `removed` semantics are E5.S2's: the review queue row model already
 *    carries a match/status note, and rejected_externals is the right memory
 *    for "never resurrect this id".
 *  - Plaid-specific riches that don't fit the shape (categories, pending
 *    flags) ride along in `raw` (ADR-006 accepts the least-common-denominator).
 */
export interface StagedTransaction {
  /** ISO YYYY-MM-DD, already normalized by the backend's parser. */
  date: string;
  /** Raw payee string; canonicalized into the payee list by the pipeline (FR-19). */
  payee: string;
  /** Signed integer milliunits — outflows negative (ADR-004). */
  amountMilliunits: Milliunits;
  /**
   * Stable per-account external identity (OFX FITID, Plaid transaction_id);
   * null when the source has none (RBC CSV) — dedup then falls back to the
   * pipeline's content-identity check.
   */
  externalId: string | null;
  memo: string;
  /**
   * Backend's account-mapping hint (Plaid account_id). File uploads carry no
   * reliable mapping (S1 AC-6) — the user chooses the target account, so this
   * stays null for the file backend.
   */
  accountHint: string | null;
  /** The backend's raw row, preserved verbatim for provenance/debugging. */
  raw: unknown;
}

/** One unparseable input row, reported with its 1-based line and reason (S1 AC-3). */
export interface ImportRowIssue {
  line: number;
  reason: string;
}

/** What a backend hands the shared pipeline: valid rows + per-row failures. */
export interface ParsedImport {
  staged: StagedTransaction[];
  errors: ImportRowIssue[];
}
