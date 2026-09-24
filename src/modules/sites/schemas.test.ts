import { describe, expect, it } from 'vitest';
import {
  SECTION_TYPES,
  isDataBoundSection,
  SECTION_LABELS,
  createSiteSchema,
  suggestSiteSlug,
} from './schemas';

/**
 * The slug rule is duplicated in two places that must not drift: the zod
 * schema here and the check constraint on sites.slug in migration 0055. If
 * they disagree, the friendly validation error is replaced by a raw database
 * constraint violation — so these cases are written against the CONSTRAINT's
 * wording, not the regex's.
 */
describe('createSiteSchema', () => {
  it.each([
    ['a plain slug', 'my-cafe'],
    ['digits', 'cafe-2024'],
    ['the shortest allowed', 'abc'],
    ['fifty characters', 'a'.repeat(50)],
  ])('accepts %s', (_label, slug) => {
    const r = createSiteSchema.safeParse({ name: 'Cafe', slug });
    expect(r.success).toBe(true);
  });

  it.each([
    ['a leading hyphen', '-cafe'],
    ['a trailing hyphen', 'cafe-'],
    ['two characters', 'ab'],
    ['fifty-one characters', 'a'.repeat(51)],
    ['an underscore', 'my_cafe'],
    ['a space', 'my cafe'],
    ['Arabic letters', 'مقهى'],
    ['an empty string', ''],
    ['a slash, which would change the route', 'my/cafe'],
    ['a dot', 'my.cafe'],
  ])('rejects %s', (_label, slug) => {
    expect(createSiteSchema.safeParse({ name: 'Cafe', slug }).success).toBe(false);
  });

  it('lowercases a slug rather than rejecting it', () => {
    const r = createSiteSchema.safeParse({ name: 'Cafe', slug: 'My-Cafe' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.slug).toBe('my-cafe');
  });

  it('trims the name and rejects one that is only whitespace', () => {
    const ok = createSiteSchema.safeParse({ name: '  Cafe  ', slug: 'cafe' });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.name).toBe('Cafe');

    expect(createSiteSchema.safeParse({ name: '   ', slug: 'cafe' }).success).toBe(false);
  });
});

describe('suggestSiteSlug', () => {
  it.each([
    ['My Cafe', 'my-cafe'],
    ['  Spaced   Out  ', 'spaced-out'],
    ['Cafe_2024', 'cafe-2024'],
    ['Punctuation!!! Here?', 'punctuation-here'],
    ['Already-Valid', 'already-valid'],
  ])('turns %j into %j', (input, expected) => {
    expect(suggestSiteSlug(input)).toBe(expected);
  });

  it('returns an empty string when nothing usable survives', () => {
    // An Arabic name slugifies to nothing in ASCII. Returning '' lets the form
    // leave the field blank for the user rather than offering a broken value.
    expect(suggestSiteSlug('مقهى الحارة')).toBe('');
    expect(suggestSiteSlug('!!!')).toBe('');
    expect(suggestSiteSlug('ab')).toBe('');
  });

  it('only ever suggests something the schema would accept', () => {
    // The name is a valid one throughout: parsing the whole object means a
    // too-short name would fail the parse and be misread as the slug being
    // rejected. It did exactly that on the first draft of this test.
    for (const name of ['My Cafe', 'Cafe_2024', 'Already-Valid', 'Punctuation!!! Here?']) {
      const slug = suggestSiteSlug(name);
      if (slug) {
        const parsed = createSiteSchema.safeParse({ name: 'Valid Name', slug });
        expect(parsed.success, `suggested slug ${slug} was rejected`).toBe(true);
      }
    }
  });
});

describe('section types', () => {
  it('carries exactly the types this build supports, in order', () => {
    // Still an exact list, not a loosened one: a type added here without a
    // renderer case, a schema and a SQL allow-list entry fails this and the
    // drift guard both.
    expect([...SECTION_TYPES]).toEqual([
      // Presentational.
      'hero',
      'about',
      'services',
      'testimonials',
      'contact',
      'footer',
      // Data-bound (Phase 3).
      'menu',
      'business_info',
      'hours',
      'branches',
    ]);
  });

  it('classifies exactly the data-bound types, and no presentational one', () => {
    expect(SECTION_TYPES.filter(isDataBoundSection)).toEqual([
      'menu',
      'business_info',
      'hours',
      'branches',
    ]);
    for (const t of ['hero', 'about', 'services', 'testimonials', 'contact', 'footer'] as const) {
      expect(isDataBoundSection(t)).toBe(false);
    }
  });

  it('labels every type, so the details screen cannot render undefined', () => {
    for (const t of SECTION_TYPES) {
      expect(SECTION_LABELS[t]).toBeTruthy();
    }
    expect(Object.keys(SECTION_LABELS).sort()).toEqual([...SECTION_TYPES].sort());
  });
});
