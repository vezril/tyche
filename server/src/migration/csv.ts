/**
 * Minimal CSV machinery for the YNAB export files (E6.S1). Same quoting rules
 * as the RBC parser in importing/filefmt (RFC-ish: `""` escapes a quote inside
 * a quoted field) — duplicated rather than imported because filefmt's helper
 * is not part of the importing module's public surface, and 30 lines of
 * line-splitting is cheaper than widening that surface.
 *
 * YNAB exports never contain embedded newlines inside fields, so records are
 * physical lines; a tolerant per-line model also keeps the 1-based line
 * numbers in the discrepancy report exactly what an editor shows (FR-31).
 */

/** One CSV record split into trimmed fields. */
export function splitCsvLine(line: string): string[] {
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

export interface CsvTable {
  /** Lower-cased header name → column index. */
  columns: Map<string, number>;
  /** Data records with their 1-based source line numbers. */
  records: { line: number; fields: string[] }[];
}

/**
 * Split a CSV document into header + records. The header is the first
 * non-empty line; blank lines are skipped. A UTF-8 BOM (Excel re-saves add
 * one) is stripped before header matching.
 */
export function readCsvTable(content: string): CsvTable | null {
  const lines = content.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  let headerLine = 0;
  while (headerLine < lines.length && (lines[headerLine] ?? '').trim() === '') headerLine += 1;
  if (headerLine >= lines.length) return null;

  const columns = new Map<string, number>();
  splitCsvLine(lines[headerLine]!).forEach((name, index) => {
    columns.set(name.toLowerCase(), index);
  });

  const records: { line: number; fields: string[] }[] = [];
  for (let i = headerLine + 1; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    if (raw.trim() === '') continue;
    records.push({ line: i + 1, fields: splitCsvLine(raw) });
  }
  return { columns, records };
}
