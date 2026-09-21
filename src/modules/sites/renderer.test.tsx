import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SiteRenderer, SectionRenderer } from './renderer';
import { SECTION_TYPES, type SectionType } from './schemas';
import type { SiteSection } from './types';

/**
 * The renderer reads `content` as Record<string, unknown> because this phase
 * stores whatever a later editor writes. Nothing validates the shape between
 * the database and the page, so the renderer is the last line: a malformed
 * block must degrade to its placeholder, never throw and take the page down.
 */

function section(
  type: SectionType,
  content: Record<string, unknown> = {},
  over: Partial<SiteSection> = {},
): SiteSection {
  return {
    id: `s-${type}`,
    pageId: 'p1',
    sectionType: type,
    content,
    sortOrder: 0,
    isVisible: true,
    ...over,
  };
}

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe('SectionRenderer', () => {
  it.each(SECTION_TYPES)('renders %s with empty content', (type) => {
    expect(() => html(<SectionRenderer section={section(type)} />)).not.toThrow();
    expect(html(<SectionRenderer section={section(type)} />).length).toBeGreaterThan(0);
  });

  it.each(SECTION_TYPES)('renders %s when every field is the wrong type', (type) => {
    // The shapes a hand-edited or half-migrated row actually takes.
    const hostile = {
      title: 42,
      subtitle: null,
      body: [],
      items: 'not-an-array',
      quote: {},
      author: undefined,
      phone: false,
      text: 0,
    };
    expect(() => html(<SectionRenderer section={section(type, hostile)} />)).not.toThrow();
  });

  it('renders list items and ignores non-object entries', () => {
    const out = html(
      <SectionRenderer
        section={section('services', {
          title: 'خدماتنا',
          items: [{ name: 'تصميم' }, null, 'junk', { name: 'تطوير' }],
        })}
      />,
    );
    expect(out).toContain('خدماتنا');
    expect(out).toContain('تصميم');
    expect(out).toContain('تطوير');
    expect(out).not.toContain('junk');
  });

  it('falls back to a placeholder for a blank string rather than rendering nothing', () => {
    const out = html(<SectionRenderer section={section('hero', { title: '   ' })} />);
    expect(out).toContain('عنوان رئيسي');
  });
});

describe('SiteRenderer', () => {
  it('shows the empty state when a page has no sections', () => {
    expect(html(<SiteRenderer sections={[]} />)).toContain('لا توجد أقسام بعد');
  });

  it('omits hidden sections', () => {
    const out = html(
      <SiteRenderer
        sections={[
          section('hero', { title: 'ظاهر' }),
          section('about', { title: 'مخفي' }, { id: 's2', isVisible: false }),
        ]}
      />,
    );
    expect(out).toContain('ظاهر');
    expect(out).not.toContain('مخفي');
  });

  it('shows the empty state when every section is hidden', () => {
    const out = html(
      <SiteRenderer sections={[section('hero', {}, { isVisible: false })]} />,
    );
    expect(out).toContain('لا توجد أقسام بعد');
  });

  it('renders sections in the order given', () => {
    const out = html(
      <SiteRenderer
        sections={[
          section('hero', { title: 'أولًا' }),
          section('footer', { text: 'أخيرًا' }, { id: 's2' }),
        ]}
      />,
    );
    expect(out.indexOf('أولًا')).toBeLessThan(out.indexOf('أخيرًا'));
  });
});
