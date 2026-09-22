import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SECTION_TYPES, type SectionType } from '../schemas';
import { SECTION_SCHEMAS, SECTION_WRITE_SCHEMAS } from './content';

/**
 * The same field list exists in three places, and it has to.
 *
 *   * SECTION_SCHEMAS       — tolerant, used when READING a stored row
 *   * SECTION_WRITE_SCHEMAS — strict, used when WRITING one
 *   * migration 0057        — a key allow-list enforced by the database, which
 *                             is the layer a direct PostgREST write does not
 *                             pass through
 *
 * Collapsing them is not possible: they run in different languages and answer
 * different questions. So the duplication is accepted and made into a tested
 * invariant instead — add a field to one and forget another, and this fails
 * rather than production.
 */

const MIGRATIONS = join(process.cwd(), 'supabase/migrations');

/**
 * The migration that CURRENTLY defines app.check_site_section_content().
 *
 * 0057 introduced it and 0059 replaced it to add the data-bound types. Pinning
 * the filename would have meant this guard quietly checking a superseded
 * definition — so it takes the last migration that defines the function, which
 * is the one the database actually ends up running.
 */
function allowListMigration(): string {
  const defining = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) =>
      readFileSync(join(MIGRATIONS, f), 'utf8').includes(
        'function app.check_site_section_content()',
      ),
    );
  if (defining.length === 0) throw new Error('no migration defines the allow-lists');
  return join(MIGRATIONS, defining[defining.length - 1]!);
}

/** The `when '<type>' then array[...]` allow-lists, as the migration writes them. */
function sqlAllowLists(): Record<string, string[]> {
  const sql = readFileSync(allowListMigration(), 'utf8');
  const out: Record<string, string[]> = {};
  const entry = /when\s+'([a-z_]+)'\s+then\s+array\[([^\]]*)\]/g;

  for (const match of sql.matchAll(entry)) {
    const type = match[1]!;
    const body = match[2] ?? '';
    out[type] = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  }
  return out;
}

/** The declared keys of a Zod object schema, in declaration order. */
function keysOf(schema: z.ZodTypeAny): string[] {
  const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
  if (!shape) throw new Error('expected a ZodObject');
  return Object.keys(shape);
}

describe('section field lists agree across all three layers', () => {
  const sql = sqlAllowLists();

  it('the migration declares an allow-list for every section type', () => {
    // Sorted, because the comparison is about membership rather than the order
    // the CASE happens to list them in.
    expect(Object.keys(sql).sort()).toEqual([...SECTION_TYPES].sort());
  });

  it.each(SECTION_TYPES)('%s: read, write and SQL declare the same fields', (type) => {
    const read = keysOf(SECTION_SCHEMAS[type]).sort();
    const write = keysOf(SECTION_WRITE_SCHEMAS[type]).sort();

    expect(write).toEqual(read);
    expect(sql[type]?.slice().sort()).toEqual(read);
  });

  it('the SQL allow-lists are non-empty, so a typo cannot silently allow nothing', () => {
    for (const type of SECTION_TYPES) {
      expect(sql[type]!.length).toBeGreaterThan(0);
    }
  });

  it('SECTION_TYPES matches the live section_type check constraint', () => {
    // The other end of the same agreement: a type the database accepts and
    // this build has no schema for would reach the renderer as a blank.
    //
    // 0055 declared the constraint inline and 0059 replaced it to admit the
    // data-bound types, so this takes the LAST migration that states the list
    // rather than pinning either filename.
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    let types: string[] | null = null;
    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
      const match = /section_type in \(([^)]*)\)/.exec(sql);
      if (match) types = [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    }
    expect(types).not.toBeNull();
    expect(types!.sort()).toEqual([...SECTION_TYPES].sort());
  });
});

describe('write schemas reject what the database rejects', () => {
  const type: SectionType = 'hero';

  it('accepts a section the template itself writes', () => {
    expect(() =>
      SECTION_WRITE_SCHEMAS[type].parse({
        title: 'اسم نشاطك هنا',
        subtitle: 'جملة قصيرة',
        ctaLabel: 'تواصل معنا',
        ctaHref: '/contact',
        align: 'center',
      }),
    ).not.toThrow();
  });

  it('accepts an empty object — a freshly created section', () => {
    for (const t of SECTION_TYPES) {
      expect(SECTION_WRITE_SCHEMAS[t].parse({})).toEqual({});
    }
  });

  it('rejects an unknown field rather than stripping it', () => {
    // The read schema would drop it silently; the write schema must not, because
    // a caller sending it has made a mistake worth hearing about.
    expect(() => SECTION_WRITE_SCHEMAS[type].parse({ title: 'ok', script: 'x' })).toThrow();
    expect(SECTION_SCHEMAS[type].parse({ title: 'ok', script: 'x' })).not.toHaveProperty('script');
  });

  it.each([
    'javascript:alert(1)',
    'https://evil.example/x',
    '//evil.example/x',
    '/\\evil.example',
    'data:text/html,<script>',
    'ftp://example.com',
  ])('rejects %s as a link target', (href) => {
    expect(() => SECTION_WRITE_SCHEMAS[type].parse({ ctaHref: href })).toThrow();
  });

  it.each(['/contact', '/about/us', 'mailto:hi@example.com', 'tel:+20 100 000 0000'])(
    'accepts %s as a link target',
    (href) => {
      expect(() => SECTION_WRITE_SCHEMAS[type].parse({ ctaHref: href })).not.toThrow();
    },
  );

  it('accepts null as "no link"', () => {
    expect(SECTION_WRITE_SCHEMAS[type].parse({ ctaHref: null })).toEqual({ ctaHref: null });
  });

  it('rejects a value past its ceiling instead of truncating it', () => {
    expect(() => SECTION_WRITE_SCHEMAS[type].parse({ title: 'x'.repeat(121) })).toThrow();
    // Read stays forgiving: the same value renders as the default rather than
    // taking the page down.
    expect(() => SECTION_SCHEMAS[type].parse({ title: 'x'.repeat(121) })).toThrow();
  });

  it('rejects an unknown field inside a nested item', () => {
    expect(() =>
      SECTION_WRITE_SCHEMAS.services.parse({ items: [{ name: 'a', colour: 'red' }] }),
    ).toThrow();
  });

  it('rejects more items than the cap allows', () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ name: String(i) }));
    expect(() => SECTION_WRITE_SCHEMAS.services.parse({ items })).toThrow();
  });
});
