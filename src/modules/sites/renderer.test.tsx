import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SiteRenderer, SectionRenderer, themeStyle } from './renderer';
import { SECTION_TYPES, type SectionType } from './schemas';
import { businessTemplate } from './templates';
import { themeSchema } from './templates/types';
import type { SiteSection } from './types';

/**
 * Nothing validates the jsonb between the database and the page except the
 * section schemas, so the renderer is the last line. A malformed block must
 * degrade to its placeholder — never throw, and never take the page with it.
 */

function section(
  type: SectionType,
  content: unknown = {},
  over: Partial<SiteSection> = {},
): SiteSection {
  return {
    id: `s-${type}`,
    pageId: 'p1',
    sectionType: type,
    content: content as Record<string, unknown>,
    sortOrder: 0,
    isVisible: true,
    ...over,
  };
}

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe('SectionRenderer', () => {
  it.each(SECTION_TYPES)('renders %s from empty content', (type) => {
    const out = html(<SectionRenderer section={section(type)} />);
    expect(out.length).toBeGreaterThan(0);
  });

  it.each(SECTION_TYPES)('renders %s when every field is the wrong type', (type) => {
    const hostile = {
      title: 42,
      subtitle: null,
      body: [],
      items: 'not-an-array',
      quote: {},
      author: undefined,
      phone: false,
      text: 0,
      align: 'diagonal',
      ctaHref: 99,
    };
    expect(() => html(<SectionRenderer section={section(type, hostile)} />)).not.toThrow();
  });

  it.each([null, undefined, 'string', 42, [], true])(
    'renders when content itself is %j rather than an object',
    (content) => {
      expect(() => html(<SectionRenderer section={section('hero', content)} />)).not.toThrow();
    },
  );

  it('renders exactly one h1, in the hero', () => {
    const out = html(
      <SiteRenderer
        sections={businessTemplate.sections.map((s, i) =>
          section(s.type, s.content, { id: `t${i}` }),
        )}
      />,
    );
    expect((out.match(/<h1/g) ?? []).length).toBe(1);
    expect(out.indexOf('<h1')).toBeLessThan(out.indexOf('<h2'));
  });

  it('gives every non-hero section an h2', () => {
    for (const type of SECTION_TYPES) {
      if (type === 'hero' || type === 'footer') continue;
      const out = html(<SectionRenderer section={section(type)} />);
      expect(out, `${type} should open with an h2`).toContain('<h2');
    }
  });
});

describe('link safety in rendered output', () => {
  it('never emits an unsafe href, whatever the content says', () => {
    for (const href of [
      'javascript:alert(1)',
      'data:text/html,<script>x</script>',
      'https://evil.example.com',
      '//evil.example.com',
    ]) {
      const out = html(
        <SectionRenderer section={section('hero', { ctaLabel: 'اضغط', ctaHref: href })} />,
      );
      expect(out).not.toContain('href=');
      expect(out.toLowerCase()).not.toContain('javascript:');
      // The label survives as text — information is not lost, only the link.
      expect(out).toContain('اضغط');
    }
  });

  it('emits a real link for a safe target', () => {
    const out = html(
      <SectionRenderer section={section('hero', { ctaLabel: 'تواصل', ctaHref: '/contact' })} />,
    );
    expect(out).toContain('href="/contact"');
  });

  it('does not render an anchor when there is no label', () => {
    const out = html(<SectionRenderer section={section('hero', { ctaHref: '/contact' })} />);
    expect(out).not.toContain('href=');
  });
});

describe('SiteRenderer', () => {
  it('shows the empty state when a page has no sections', () => {
    expect(html(<SiteRenderer sections={[]} />)).toContain('لا توجد أقسام بعد');
  });

  it('omits hidden sections, and is empty when all are hidden', () => {
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

    expect(
      html(<SiteRenderer sections={[section('hero', {}, { isVisible: false })]} />),
    ).toContain('لا توجد أقسام بعد');
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

  it('defaults to RTL and honours an explicit direction', () => {
    expect(html(<SiteRenderer sections={[section('hero')]} />)).toContain('dir="rtl"');
    expect(
      html(<SiteRenderer sections={[section('hero')]} direction="ltr" />),
    ).toContain('dir="ltr"');
  });
});

describe('theme', () => {
  it('converts hex to the rgb channel triples the CSS variables expect', () => {
    const style = themeStyle(themeSchema.parse({ primary: '#ff0000' }));
    expect(style['--site-primary' as keyof typeof style]).toBe('255 0 0');
  });

  it('falls back rather than letting an arbitrary string reach a style attribute', () => {
    for (const bad of ['red', 'javascript:x', '#xyz', '', 'rgb(1,2,3)', '#12345']) {
      const parsed = themeSchema.parse({ primary: bad });
      expect(parsed.primary).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('renders a theme from unvalidated input without emitting it verbatim', () => {
    const out = html(
      <SiteRenderer sections={[section('hero')]} theme={{ primary: 'expression(alert(1))' }} />,
    );
    expect(out).not.toContain('expression(');
  });

  it('accepts a partial theme and fills the rest', () => {
    const parsed = themeSchema.parse({ primary: '#123456' });
    expect(parsed.primary).toBe('#123456');
    expect(parsed.background).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});

describe('business template', () => {
  it('only uses section types the renderer implements', () => {
    for (const s of businessTemplate.sections) {
      expect(SECTION_TYPES).toContain(s.type);
    }
  });

  it('starts with a hero and ends with a footer', () => {
    expect(businessTemplate.sections[0]?.type).toBe('hero');
    expect(businessTemplate.sections.at(-1)?.type).toBe('footer');
  });

  it('renders end to end with its own default content', () => {
    const out = html(
      <SiteRenderer
        theme={businessTemplate.theme}
        sections={businessTemplate.sections.map((s, i) =>
          section(s.type, s.content, { id: `t${i}` }),
        )}
      />,
    );
    expect(out).toContain('اسم نشاطك هنا');
    expect(out).toContain('من نحن');
    expect(out).toContain('خدماتنا');
    expect(out).toContain('آراء العملاء');
    expect(out).not.toContain('undefined');
    expect(out).not.toContain('[object Object]');
  });
});
