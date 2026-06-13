import { parseDollarsToMilliunits } from '@ynab-clone/shared';
import type { ImportRowIssue, ParsedImport, StagedTransaction } from '../port.js';

/**
 * Tolerant minimal OFX 1.x parser (FR-24). RBC's OFX/QFX exports are SGML-ish
 * OFX 1.x: leaf elements have NO closing tags, headers are key:value lines,
 * and the only part this app needs is the <STMTTRN> blocks. A heavyweight OFX
 * dependency would be NFR-2 surface for no gain — this extracts exactly the
 * fields the StagedTransaction shape wants and reports anything unparseable
 * per row (S1 AC-3).
 *
 * Tolerances, deliberately:
 *  - case-insensitive tags;
 *  - values end at the next '<' or end-of-line, so OFX 2.x (XML) closing tags
 *    parse identically;
 *  - DTPOSTED accepts YYYYMMDD with any trailing time/zone garbage
 *    ("20260601120000[-5:EST]");
 *  - TRNAMT accepts an optional leading '+' and thousands commas.
 *
 * Amounts are parsed via the audited string-based parser (ADR-004) — no
 * binary float ever touches a TRNAMT.
 */

const STMTTRN_BLOCK = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;

function tagValue(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i').exec(block);
  if (!match) return null;
  const value = (match[1] ?? '').trim();
  return value === '' ? null : value;
}

/** "20260601120000[-5:EST]" → "2026-06-01"; null when not a calendar date. */
function parseOfxDate(raw: string): string | null {
  const digits = /^(\d{4})(\d{2})(\d{2})/.exec(raw.trim());
  if (!digits) return null;
  const iso = `${digits[1]}-${digits[2]}-${digits[3]}`;
  const roundTrip = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(roundTrip.getTime()) || !roundTrip.toISOString().startsWith(iso)) return null;
  return iso;
}

/** 1-based line number of an offset into the file, for per-row error reports. */
function lineOf(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

export function parseOfx(content: string): ParsedImport {
  const staged: StagedTransaction[] = [];
  const errors: ImportRowIssue[] = [];

  for (const match of content.matchAll(STMTTRN_BLOCK)) {
    const block = match[1] ?? '';
    const line = lineOf(content, match.index);

    const rawDate = tagValue(block, 'DTPOSTED');
    const date = rawDate === null ? null : parseOfxDate(rawDate);
    if (date === null) {
      errors.push({ line, reason: `unparseable DTPOSTED: "${rawDate ?? ''}"` });
      continue;
    }

    const rawAmount = tagValue(block, 'TRNAMT');
    if (rawAmount === null) {
      errors.push({ line, reason: 'missing TRNAMT' });
      continue;
    }
    let amount;
    try {
      // strip an optional '+' and thousands commas; string-based parse (ADR-004)
      amount = parseDollarsToMilliunits(rawAmount.replace(/^\+/, '').replace(/,/g, ''));
    } catch {
      errors.push({ line, reason: `unparseable TRNAMT: "${rawAmount}"` });
      continue;
    }

    // NAME is the payee; some exports put the better string in MEMO. FITID is
    // the external identity S3's T1 dedup keys on — REQUIRED by the OFX spec,
    // but tolerated when absent (the row then dedups by content instead).
    const name = tagValue(block, 'NAME');
    const memo = tagValue(block, 'MEMO');
    staged.push({
      date,
      payee: name ?? memo ?? '',
      amountMilliunits: amount,
      externalId: tagValue(block, 'FITID'),
      memo: name === null ? '' : (memo ?? ''),
      accountHint: null,
      raw: block.trim(),
    });
  }

  return { staged, errors };
}
