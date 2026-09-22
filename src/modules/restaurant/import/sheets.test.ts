import { describe, expect, it } from 'vitest';
import { parseSheetUrl, SheetSourceError } from './sheets';

/**
 * The URL gate.
 *
 * This is the only place the importer can be talked into making an outbound
 * request, so it is where SSRF would live if it lived anywhere. The fetch
 * itself is not exercised here — see the note in the report — but the decision
 * about WHAT may be fetched is entirely in this function, and it is total.
 */

describe('accepted links', () => {
  it('reads the document id out of a normal share link', () => {
    const s = parseSheetUrl(
      'https://docs.google.com/spreadsheets/d/1AbC_dEfGhIjKlMnOpQrStUvWxYz012345/edit#gid=0',
    );
    expect(s.documentId).toBe('1AbC_dEfGhIjKlMnOpQrStUvWxYz012345');
    expect(s.gid).toBe('0');
    expect(s.exportUrl).toBe(
      'https://docs.google.com/spreadsheets/d/1AbC_dEfGhIjKlMnOpQrStUvWxYz012345/export?format=csv&gid=0',
    );
  });

  it('reads a gid from the query as well as the fragment', () => {
    expect(
      parseSheetUrl(
        'https://docs.google.com/spreadsheets/d/1AbC_dEfGhIjKlMnOpQrStUvWxYz012345/export?gid=42',
      ).gid,
    ).toBe('42');
  });

  it('works without a gid', () => {
    const s = parseSheetUrl(
      'https://docs.google.com/spreadsheets/d/1AbC_dEfGhIjKlMnOpQrStUvWxYz012345/',
    );
    expect(s.gid).toBeNull();
    expect(s.exportUrl.endsWith('/export?format=csv')).toBe(true);
  });

  it('builds the export URL rather than reusing what was pasted', () => {
    // A pasted query string, fragment or extra path must not survive: the
    // request is assembled from an id and a gid and nothing else.
    const s = parseSheetUrl(
      'https://docs.google.com/spreadsheets/d/1AbC_dEfGhIjKlMnOpQrStUvWxYz012345/edit?usp=sharing&range=A1:Z9#gid=7&foo=bar',
    );
    expect(s.exportUrl).toBe(
      'https://docs.google.com/spreadsheets/d/1AbC_dEfGhIjKlMnOpQrStUvWxYz012345/export?format=csv&gid=7',
    );
    expect(s.exportUrl).not.toContain('usp');
    expect(s.exportUrl).not.toContain('range');
    expect(s.exportUrl).not.toContain('foo');
  });
});

describe('refused links', () => {
  it.each([
    ['not a url', 'hello'],
    ['http', 'http://docs.google.com/spreadsheets/d/1AbC_dEfGhIjKlMnOpQrStUvWxYz012345/'],
    ['a look-alike host', 'https://docs.google.com.evil.example/spreadsheets/d/1AbC_dEfGhIjKlMnOpQrStUvWxYz012345/'],
    ['a subdomain trick', 'https://evil.docs.google.com/spreadsheets/d/1AbC_dEfGhIjKlMnOpQrStUvWxYz012345/'],
    ['userinfo smuggling', 'https://docs.google.com@evil.example/spreadsheets/d/1AbC_dEfGhIjKlMnOpQrStUvWxYz012345/'],
    ['localhost', 'https://localhost/spreadsheets/d/1AbC_dEfGhIjKlMnOpQrStUvWxYz012345/'],
    ['loopback', 'https://127.0.0.1/spreadsheets/d/1AbC_dEfGhIjKlMnOpQrStUvWxYz012345/'],
    ['a private address', 'https://10.0.0.5/spreadsheets/d/1AbC_dEfGhIjKlMnOpQrStUvWxYz012345/'],
    ['cloud metadata', 'https://169.254.169.254/spreadsheets/d/1AbC_dEfGhIjKlMnOpQrStUvWxYz012345/'],
    ['a file url', 'file:///etc/passwd'],
    ['another google product', 'https://drive.google.com/file/d/1AbC_dEfGhIjKlMnOpQrStUvWxYz012345/'],
    ['no document id', 'https://docs.google.com/spreadsheets/'],
    ['too short an id', 'https://docs.google.com/spreadsheets/d/abc/'],
  ])('refuses %s', (_name, url) => {
    expect(() => parseSheetUrl(url)).toThrow(SheetSourceError);
  });

  it('refuses every refusal with a message and never a thrown TypeError', () => {
    // A caller shows these to an admin, so they must be the typed error.
    for (const bad of ['', '   ', 'javascript:alert(1)', '//docs.google.com/x']) {
      expect(() => parseSheetUrl(bad)).toThrow(SheetSourceError);
    }
  });
});
