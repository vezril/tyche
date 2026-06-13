import { ImportError } from '../errors.js';
import type { ParsedImport } from '../port.js';
import { parseRbcCsv } from './csv.js';
import { parseOfx } from './ofx.js';

/**
 * The FILE backend of the importer port (ADR-006): OFX/QFX + RBC CSV → the
 * common StagedTransaction shape. Format detection prefers the filename
 * extension (what RBC actually names its downloads) and falls back to content
 * sniffing, so a renamed file still imports.
 */

export type FileFormat = 'ofx' | 'csv';

export function detectFormat(filename: string, content: string): FileFormat {
  const extension = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
  if (extension === 'ofx' || extension === 'qfx') return 'ofx';
  if (extension === 'csv') return 'csv';
  if (/OFXHEADER|<OFX>|<STMTTRN>/i.test(content)) return 'ofx';
  if (/transaction date/i.test(content.split(/\r\n|\r|\n/, 1)[0] ?? '')) return 'csv';
  throw new ImportError('unsupported_format', { filename });
}

export interface ParsedImportFile extends ParsedImport {
  format: FileFormat;
}

export function parseImportFile(filename: string, content: string): ParsedImportFile {
  if (content.trim() === '') throw new ImportError('empty_file');
  const format = detectFormat(filename, content);
  const parsed = format === 'ofx' ? parseOfx(content) : parseRbcCsv(content);
  return { format, ...parsed };
}

export { parseOfx } from './ofx.js';
export { parseRbcCsv } from './csv.js';
