import { inflateRawSync } from 'node:zlib';

/**
 * Reading a spreadsheet, safely.
 *
 * NO DEPENDENCY. The repository has no spreadsheet library, and adding one for
 * this would pull a large surface — most of which exists to WRITE files and to
 * evaluate formulas, neither of which an importer should be able to do. What is
 * needed is narrow enough to state exactly:
 *
 *   * a .xlsx is a ZIP of XML. Read the shared-string table and one sheet.
 *   * read only each cell's CACHED VALUE (<v>) or inline string. A <f> formula
 *     element is skipped without being looked at, so nothing is ever evaluated.
 *   * macros live in xl/vbaProject.bin, which is never opened.
 *
 * Every value that comes out of here is a trimmed string and is treated as
 * hostile until a schema says otherwise.
 */

/** Bounds, applied before any allocation that depends on file content. */
export const IMPORT_LIMITS = {
  /** 5 MB. A menu is a few hundred rows; anything larger is a mistake. */
  maxBytes: 5 * 1024 * 1024,
  maxRows: 2000,
  maxColumns: 60,
  /** A single cell longer than this is truncated rather than stored. */
  maxCellLength: 2000,
  /** Guards against a zip bomb: total inflated bytes across all entries. */
  maxInflatedBytes: 40 * 1024 * 1024,
} as const;

export type SheetTable = {
  headers: string[];
  rows: string[][];
  /** Present for formats that name their sheet. */
  sheetName?: string;
};

export class ImportParseError extends Error {}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * RFC4180-ish: quoted fields, doubled quotes inside them, CRLF or LF.
 *
 * Written out rather than split on commas because a menu description with a
 * comma in it is the common case, not the edge case.
 */
export function parseCsv(text: string): SheetTable {
  // A BOM would otherwise become part of the first header's name.
  const input = text.replace(/^﻿/, '');

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    // A trailing newline produces one empty field, which is not a row.
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };

  while (i < input.length) {
    const ch = input[i]!;
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i += 1;
      if (rows.length > IMPORT_LIMITS.maxRows + 1) {
        throw new ImportParseError('too many rows');
      }
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== '' || row.length) endRow();

  return toTable(rows);
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

/** One file inside the archive, inflated. */
function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  // The End Of Central Directory record is at the tail, after a comment of
  // unknown length, so it is searched for backwards from the end.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 66_000; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new ImportParseError('not a valid xlsx file');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  let inflated = 0;

  for (let n = 0; n < count; n += 1) {
    if (offset + 46 > buffer.length) throw new ImportParseError('corrupt archive');
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    // Only the three parts a value reader needs. vbaProject.bin, images,
    // printer settings and everything else are never even located.
    const wanted =
      name === 'xl/sharedStrings.xml' ||
      name === 'xl/workbook.xml' ||
      /^xl\/worksheets\/sheet\d+\.xml$/.test(name);

    if (wanted) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const raw = buffer.subarray(start, start + compressedSize);
      const content = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);

      inflated += content.length;
      if (inflated > IMPORT_LIMITS.maxInflatedBytes) {
        throw new ImportParseError('archive contents are too large');
      }
      entries.set(name, content);
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeXml(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return String.fromCodePoint(parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return XML_ENTITIES[entity] ?? whole;
  });
}

/** The shared-string table: <si> entries, each possibly split across runs. */
function readSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let text = '';
    for (const t of si[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += decodeXml(t[1]!);
    out.push(text);
  }
  return out;
}

/** 'BC12' → 54. Column letters are base-26 with no zero. */
function columnIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readSheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];

  for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];

    for (const cell of rowMatch[1]!.matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cell[1]!;
      const body = cell[2]!;
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? '';
      const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? 'n';

      let value = '';
      if (type === 'inlineStr') {
        for (const t of body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) value += decodeXml(t[1]!);
      } else {
        // <v> is the CACHED value. A sibling <f> holds the formula and is
        // never read, so nothing here can evaluate anything.
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        if (v !== undefined) {
          value = type === 's' ? (shared[Number(v)] ?? '') : decodeXml(v);
        }
      }

      const index = ref ? columnIndex(ref) : cells.length;
      if (index >= IMPORT_LIMITS.maxColumns) continue;
      // Sparse sheets skip empty cells, so gaps are filled to keep a row's
      // values aligned with its headers.
      while (cells.length < index) cells.push('');
      cells[index] = value;
    }

    rows.push(cells);
    if (rows.length > IMPORT_LIMITS.maxRows + 1) {
      throw new ImportParseError('too many rows');
    }
  }

  return rows;
}

export function parseXlsx(buffer: Buffer): SheetTable {
  const entries = readZipEntries(buffer);

  const sheetNames = [...entries.keys()]
    .filter((k) => k.startsWith('xl/worksheets/'))
    .sort();
  const first = sheetNames[0];
  if (!first) throw new ImportParseError('the workbook has no sheets');

  const shared = entries.has('xl/sharedStrings.xml')
    ? readSharedStrings(entries.get('xl/sharedStrings.xml')!.toString('utf8'))
    : [];

  const table = toTable(readSheet(entries.get(first)!.toString('utf8'), shared));

  // The workbook names its sheets in document order, which matches the sorted
  // sheetN.xml order closely enough to label the first one.
  const workbook = entries.get('xl/workbook.xml')?.toString('utf8');
  const name = workbook ? /<sheet[^>]*name="([^"]*)"/.exec(workbook)?.[1] : undefined;

  return { ...table, sheetName: name ? decodeXml(name) : undefined };
}

// ---------------------------------------------------------------------------

/** Normalises a raw grid into headers plus rows. */
function toTable(grid: string[][]): SheetTable {
  const cleaned = grid
    .map((row) =>
      row
        .slice(0, IMPORT_LIMITS.maxColumns)
        .map((cell) => String(cell ?? '').trim().slice(0, IMPORT_LIMITS.maxCellLength)),
    )
    // A row of nothing but blanks is spacing, not data.
    .filter((row) => row.some((cell) => cell !== ''));

  const [headerRow, ...rest] = cleaned;
  if (!headerRow) throw new ImportParseError('the sheet is empty');

  const headers = headerRow.map((h, i) => (h === '' ? `عمود ${i + 1}` : h));

  return {
    headers,
    // Ragged rows are padded so every row has one cell per header.
    rows: rest.map((row) => {
      const out = row.slice(0, headers.length);
      while (out.length < headers.length) out.push('');
      return out;
    }),
  };
}
