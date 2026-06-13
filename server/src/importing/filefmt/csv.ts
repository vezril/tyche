import { parseDollarsToMilliunits } from '@tyche/shared';
import { ImportError } from '../errors.js';
import type { ImportRowIssue, ParsedImport, StagedTransaction } from '../port.js';

/**
 * RBC CSV parser (FR-24). The real export format (Account Activity download):
 *
 *   "Account Type","Account Number","Transaction Date","Cheque Number",
 *   "Description 1","Description 2","CAD$","USD$"
 *
 * Dates are M/D/YYYY, amounts are signed dollar strings in the CAD$ column
 * (USD$ for the rare USD-side row — not importable into a CAD ledger, so
 * reported as a per-row error rather than guessed at). There is NO external
 * id — staged rows carry externalId null and dedup falls back to the
 * pipeline's content-identity check (S3).
 *
 * The header is matched by NAME (case-insensitive), not position, so column
 * reordering or extra columns in a future RBC export survive. All amount
 * parsing is string-based (ADR-004, FR-32) — never a float.
 */

interface HeaderMap {
  date: number;
  description1: number;
  description2: number | null;
  cheque: number | null;
  cad: number;
}

/** One CSV record, quotes per RFC-ish rules ("" escapes a quote inside quotes). */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}

function findColumn(header: string[], name: string): number | null {
  const index = header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  return index === -1 ? null : index;
}

function mapHeader(header: string[]): HeaderMap {
  const date = findColumn(header, 'Transaction Date');
  const description1 = findColumn(header, 'Description 1');
  const cad = findColumn(header, 'CAD$');
  if (date === null || description1 === null || cad === null) {
    throw new ImportError('unsupported_format', {
      reason: 'missing RBC columns (Transaction Date / Description 1 / CAD$)',
    });
  }
  return {
    date,
    description1,
    description2: findColumn(header, 'Description 2'),
    cheque: findColumn(header, 'Cheque Number'),
    cad,
  };
}

/** "6/1/2026" (RBC M/D/YYYY) or "2026-06-01" → ISO; null when not a real date. */
function parseCsvDate(raw: string): string | null {
  let iso: string | null = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    iso = raw;
  } else {
    const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
    if (mdy) iso = `${mdy[3]}-${mdy[1]!.padStart(2, '0')}-${mdy[2]!.padStart(2, '0')}`;
  }
  if (iso === null) return null;
  const roundTrip = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(roundTrip.getTime()) || !roundTrip.toISOString().startsWith(iso)) return null;
  return iso;
}

export function parseRbcCsv(content: string): ParsedImport {
  const lines = content.split(/\r\n|\r|\n/);
  const staged: StagedTransaction[] = [];
  const errors: ImportRowIssue[] = [];

  // The header is the first non-empty line; its absence is a format error for
  // the WHOLE file (nothing after it could parse), not a per-row one.
  let headerLine = 0;
  while (headerLine < lines.length && (lines[headerLine] ?? '').trim() === '') headerLine += 1;
  if (headerLine >= lines.length) throw new ImportError('empty_file');
  const columns = mapHeader(splitCsvLine(lines[headerLine]!));

  for (let i = headerLine + 1; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    if (raw.trim() === '') continue;
    const line = i + 1; // 1-based, header included — matches what an editor shows
    const fields = splitCsvLine(raw);

    const date = parseCsvDate(fields[columns.date] ?? '');
    if (date === null) {
      errors.push({ line, reason: `unparseable Transaction Date: "${fields[columns.date] ?? ''}"` });
      continue;
    }

    const cad = (fields[columns.cad] ?? '').replace(/,/g, '').replace(/^\+/, '');
    if (cad === '') {
      // USD-side rows leave CAD$ blank — refusing beats silently importing USD as CAD.
      errors.push({ line, reason: 'no CAD$ amount (USD-only rows are not importable)' });
      continue;
    }
    let amount;
    try {
      amount = parseDollarsToMilliunits(cad);
    } catch {
      errors.push({ line, reason: `unparseable CAD$ amount: "${fields[columns.cad] ?? ''}"` });
      continue;
    }

    const description2 =
      columns.description2 === null ? '' : (fields[columns.description2] ?? '');
    const cheque = columns.cheque === null ? '' : (fields[columns.cheque] ?? '');
    const memoParts = [description2, cheque === '' ? '' : `Cheque #${cheque}`].filter(
      (p) => p !== '',
    );

    staged.push({
      date,
      payee: fields[columns.description1] ?? '',
      amountMilliunits: amount,
      externalId: null, // RBC CSV carries no stable id
      memo: memoParts.join(' · '),
      accountHint: null,
      raw,
    });
  }

  return { staged, errors };
}
