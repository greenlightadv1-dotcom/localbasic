import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IMPORT_LIMITS, ImportParseError, parseCsv, parseXlsx } from './parse';

/** Builds a real .xlsx with Python's zipfile, so the reader meets a real one. */
function xlsx(sheetXml: string, shared: string[] = [], extra = ''): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'xlsx-'));
  const script = join(dir, 'make.py');
  const out = join(dir, 'book.xlsx');
  writeFileSync(
    script,
    `import zipfile, json, sys
shared = json.loads(sys.argv[1]); sheet = sys.argv[2]; out = sys.argv[3]
import html
sst = '<sst count="%d" uniqueCount="%d">' % (len(shared), len(shared)) + ''.join('<si><t>%s</t></si>' % html.escape(s) for s in shared) + '</sst>'
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', '<Types/>')
    z.writestr('xl/workbook.xml', '<workbook><sheets><sheet name="Sheet1"/></sheets></workbook>')
    if shared: z.writestr('xl/sharedStrings.xml', sst)
    z.writestr('xl/worksheets/sheet1.xml', '<worksheet><sheetData>' + sheet + '</sheetData></worksheet>')
    z.writestr('xl/vbaProject.bin', b'\\x00MACRO')
${extra}
`,
    'utf8',
  );
  execFileSync('python3', [script, JSON.stringify(shared), sheetXml, out]);
  return readFileSync(out);
}

describe('CSV', () => {
  it('reads headers and rows', () => {
    const t = parseCsv('name,price\nلاتيه,65\nتشيز كيك,120\n');
    expect(t.headers).toEqual(['name', 'price']);
    expect(t.rows).toEqual([
      ['لاتيه', '65'],
      ['تشيز كيك', '120'],
    ]);
  });

  it('keeps commas inside quoted fields', () => {
    const t = parseCsv('name,description\n"لاتيه","حليب, إسبريسو, وقرفة"\n');
    expect(t.rows[0]).toEqual(['لاتيه', 'حليب, إسبريسو, وقرفة']);
  });

  it('handles doubled quotes and CRLF', () => {
    const t = parseCsv('a,b\r\n"say ""hi""",2\r\n');
    expect(t.rows[0]).toEqual(['say "hi"', '2']);
  });

  it('strips a BOM so the first header is not corrupted', () => {
    expect(parseCsv('﻿name,price\nx,1\n').headers).toEqual(['name', 'price']);
  });

  it('pads a ragged row and drops a blank one', () => {
    const t = parseCsv('a,b,c\n1\n\n2,3,4\n');
    expect(t.rows).toEqual([
      ['1', '', ''],
      ['2', '3', '4'],
    ]);
  });

  it('refuses an empty sheet', () => {
    expect(() => parseCsv('')).toThrow(ImportParseError);
  });

  it('refuses more rows than the limit', () => {
    const many = 'a\n' + 'x\n'.repeat(IMPORT_LIMITS.maxRows + 5);
    expect(() => parseCsv(many)).toThrow(ImportParseError);
  });
});

describe('XLSX', () => {
  it('reads shared strings, inline strings and numbers', () => {
    const buffer = xlsx(
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>price</t></is></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>65</v></c></row>',
      ['الاسم', 'لاتيه'],
    );
    const t = parseXlsx(buffer);
    expect(t.headers).toEqual(['الاسم', 'price']);
    expect(t.rows).toEqual([['لاتيه', '65']]);
    expect(t.sheetName).toBe('Sheet1');
  });

  it('reads a formula cell as its cached value and never evaluates it', () => {
    // <f> is present and is never read. The value is the one Excel stored.
    const buffer = xlsx(
      '<row r="1"><c r="A1" t="inlineStr"><is><t>total</t></is></c></row>' +
        '<row r="2"><c r="A2"><f>SUM(1,2)</f><v>3</v></c></row>',
    );
    const t = parseXlsx(buffer);
    expect(t.rows).toEqual([['3']]);
    expect(JSON.stringify(t)).not.toContain('SUM');
  });

  it('fills the gap a sparse row leaves, so values stay under their headers', () => {
    const buffer = xlsx(
      '<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="B1" t="inlineStr"><is><t>b</t></is></c><c r="C1" t="inlineStr"><is><t>c</t></is></c></row>' +
        // No B2: the value in C2 must stay under header c.
        '<row r="2"><c r="A2"><v>1</v></c><c r="C2"><v>3</v></c></row>',
    );
    expect(parseXlsx(buffer).rows).toEqual([['1', '', '3']]);
  });

  it('decodes XML entities rather than storing them raw', () => {
    const buffer = xlsx(
      '<row r="1"><c r="A1" t="inlineStr"><is><t>name</t></is></c></row>' +
        '<row r="2"><c r="A2" t="inlineStr"><is><t>Tea &amp; Coffee &lt;hot&gt;</t></is></c></row>',
    );
    expect(parseXlsx(buffer).rows[0]).toEqual(['Tea & Coffee <hot>']);
  });

  it('never opens the macro part', () => {
    // The fixture always contains xl/vbaProject.bin with a payload; it must
    // not appear anywhere in the parsed output.
    const buffer = xlsx(
      '<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c></row>' +
        '<row r="2"><c r="A2"><v>1</v></c></row>',
    );
    expect(JSON.stringify(parseXlsx(buffer))).not.toContain('MACRO');
  });

  it('refuses a file that is not a zip', () => {
    expect(() => parseXlsx(Buffer.from('this is not a spreadsheet'))).toThrow(ImportParseError);
  });

  it('refuses a workbook with no sheet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xlsx-'));
    const script = join(dir, 'm.py');
    const out = join(dir, 'b.xlsx');
    writeFileSync(
      script,
      `import zipfile, sys
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    z.writestr('xl/workbook.xml', '<workbook/>')
`,
      'utf8',
    );
    execFileSync('python3', [script, out]);
    expect(() => parseXlsx(readFileSync(out))).toThrow(ImportParseError);
  });
});
