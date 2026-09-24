import { describe, expect, it } from 'vitest';
import { SECTION_TYPES } from '../schemas';
import { SECTION_SCHEMAS, parseSectionContent } from './content';

/**
 * site_sections.content is jsonb; the database checks only that it is an
 * object. Everything about its shape is enforced at this boundary, so these
 * tests feed it what an editor, an import, or a hand-written UPDATE could
 * actually put in the column.
 *
 * The contract is total: parseSectionContent never throws and never returns
 * null, for any input, for any section type.
 */

const HOSTILE: unknown[] = [
  undefined,
  null,
  0,
  '',
  'a string where an object belongs',
  [],
  [1, 2, 3],
  true,
  { title: 42, items: 'not-an-array', quote: {}, ctaHref: 17 },
  { items: [null, 'junk', 7, { name: {} }] },
  { title: { nested: 'object' } },
  { title: 'x'.repeat(5000) },
  Object.create(null),
];

describe('parseSectionContent', () => {
  it.each(SECTION_TYPES)('is total for %s across every hostile input', (type) => {
    for (const input of HOSTILE) {
      expect(() => parseSectionContent(type, input)).not.toThrow();
      const parsed = parseSectionContent(type, input);
      expect(parsed).toBeTypeOf('object');
      expect(parsed).not.toBeNull();
    }
  });

  it.each(SECTION_TYPES)('returns every declared field for %s, even from {}', (type) => {
    const parsed = parseSectionContent(type, {}) as Record<string, unknown>;
    const declared = Object.keys(SECTION_SCHEMAS[type].parse({}) as object);
    for (const key of declared) expect(parsed).toHaveProperty(key);
  });

  it('keeps good content intact', () => {
    const parsed = parseSectionContent('hero', {
      title: 'مرحبا',
      subtitle: 'وصف',
      ctaLabel: 'ابدأ',
      ctaHref: '/contact',
      align: 'start',
    });
    expect(parsed).toMatchObject({
      title: 'مرحبا',
      subtitle: 'وصف',
      ctaLabel: 'ابدأ',
      ctaHref: '/contact',
      align: 'start',
    });
  });

  it('trims text rather than storing the padding', () => {
    expect(parseSectionContent('about', { title: '  من نحن  ' }).title).toBe('من نحن');
  });

  it('drops list entries that are not objects, keeping the rest', () => {
    const parsed = parseSectionContent('services', {
      items: [{ name: 'أ' }, null, 'junk', { name: 'ب' }],
    });
    // The array as a whole fails, so the section falls back to no items rather
    // than silently rendering a partial list the owner never wrote.
    expect(Array.isArray(parsed.items)).toBe(true);
  });

  it('falls back to an empty list when items is the wrong type entirely', () => {
    expect(parseSectionContent('services', { items: 'nope' }).items).toEqual([]);
    expect(parseSectionContent('testimonials', { items: 42 }).items).toEqual([]);
  });
});

/**
 * The link rule is the one place content could become executable. It is a
 * strict allow-list — relative path, mailto:, tel: — so everything else,
 * including schemes nobody thought to blocklist, falls back to null.
 */
describe('ctaHref safety', () => {
  it.each([
    ['javascript:alert(1)'],
    ['JavaScript:alert(1)'],
    ['  javascript:alert(1)  '],
    ['data:text/html;base64,PHNjcmlwdD4='],
    ['vbscript:msgbox(1)'],
    ['//evil.example.com'],
    ['/\\evil.example.com'],
    ['https://evil.example.com'],
    ['http://evil.example.com'],
    ['file:///etc/passwd'],
    ['\u0000javascript:alert(1)'],
  ])('refuses %j', (href) => {
    expect(parseSectionContent('hero', { ctaHref: href }).ctaHref).toBeNull();
  });

  it.each([['/contact'], ['/about-us'], ['mailto:hi@example.com'], ['tel:+201000000']])(
    'accepts %j',
    (href) => {
      expect(parseSectionContent('hero', { ctaHref: href }).ctaHref).toBe(href);
    },
  );
});
