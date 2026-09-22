import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SiteRenderer, SectionRenderer, themeStyle } from './renderer';
import { SECTION_TYPES, type SectionType } from './schemas';
import { businessTemplate } from './templates';
import { themeSchema } from './templates/types';
import type { SitePage, SiteSection } from './types';
import type { ResolvedSectionData } from './resolved';

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

function page(over: Partial<SitePage> = {}): SitePage {
  return {
    id: 'p1',
    siteId: 'site-1',
    title: 'الرئيسية',
    slug: 'home',
    isHomepage: true,
    sortOrder: 0,
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
      <SiteRenderer page={page()} sections={businessTemplate.sections.map((s, i) =>
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
    expect(html(<SiteRenderer page={page()} sections={[]} />)).toContain('لا توجد أقسام بعد');
  });

  it('omits hidden sections, and is empty when all are hidden', () => {
    const out = html(
      <SiteRenderer page={page()} sections={[
          section('hero', { title: 'ظاهر' }),
          section('about', { title: 'مخفي' }, { id: 's2', isVisible: false }),
        ]}
      />,
    );
    expect(out).toContain('ظاهر');
    expect(out).not.toContain('مخفي');

    expect(
      html(<SiteRenderer page={page()} sections={[section('hero', {}, { isVisible: false })]} />),
    ).toContain('لا توجد أقسام بعد');
  });

  it('renders sections in the order given', () => {
    const out = html(
      <SiteRenderer page={page()} sections={[
          section('hero', { title: 'أولًا' }),
          section('footer', { text: 'أخيرًا' }, { id: 's2' }),
        ]}
      />,
    );
    expect(out.indexOf('أولًا')).toBeLessThan(out.indexOf('أخيرًا'));
  });

  it('defaults to RTL and honours an explicit direction', () => {
    expect(html(<SiteRenderer page={page()} sections={[section('hero')]} />)).toContain('dir="rtl"');
    expect(
      html(<SiteRenderer page={page()} sections={[section('hero')]} direction="ltr" />),
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
      <SiteRenderer page={page()} sections={[section('hero')]} theme={{ primary: 'expression(alert(1))' }} />,
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
      <SiteRenderer page={page()} theme={businessTemplate.theme}
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

/**
 * Multi-page rendering (Phase 2).
 *
 * The acceptance criterion for this phase is not "several pages can be
 * loaded" — it is that page B can be selected and rendered through the SAME
 * renderer without any of homepage A's content appearing. So these assertions
 * are on section-level CONTENT, not on titles: a title check would pass even
 * if the renderer silently drew A's sections under B's name.
 */
describe('multi-page rendering', () => {
  const HOME = page({ id: 'page-a', title: 'الرئيسية', slug: 'home', isHomepage: true });
  const INNER = page({ id: 'page-b', title: 'من نحن', slug: 'about-us', isHomepage: false });

  // Distinctive strings, so an accidental fallback is unmissable in the markup.
  const homeSections: SiteSection[] = [
    section('hero', { title: 'HOMEPAGE_HERO_MARKER' }, { id: 'a1', pageId: 'page-a' }),
    section('about', { title: 'HOMEPAGE_ABOUT_MARKER' }, { id: 'a2', pageId: 'page-a' }),
  ];
  const innerSections: SiteSection[] = [
    section('about', { title: 'INNER_ABOUT_MARKER' }, { id: 'b1', pageId: 'page-b', sortOrder: 0 }),
    section(
      'services',
      { title: 'INNER_SERVICES_MARKER' },
      { id: 'b2', pageId: 'page-b', sortOrder: 1 },
    ),
  ];

  it('renders the homepage when the homepage is supplied', () => {
    const out = html(<SiteRenderer page={HOME} sections={homeSections} />);
    expect(out).toContain('HOMEPAGE_HERO_MARKER');
    expect(out).toContain('HOMEPAGE_ABOUT_MARKER');
    expect(out).not.toContain('INNER_ABOUT_MARKER');
  });

  it('renders a non-homepage page when that page is supplied', () => {
    const out = html(<SiteRenderer page={INNER} sections={innerSections} />);
    expect(out).toContain('INNER_ABOUT_MARKER');
    expect(out).toContain('INNER_SERVICES_MARKER');
  });

  // THE REGRESSION TEST for the old behaviour. Given homepage A and page B,
  // ask for B: B renders and A does not appear at all.
  it('given homepage A and page B, rendering B shows none of A', () => {
    const out = html(<SiteRenderer page={INNER} sections={innerSections} />);
    expect(out).toContain('INNER_ABOUT_MARKER');
    expect(out).not.toContain('HOMEPAGE_HERO_MARKER');
    expect(out).not.toContain('HOMEPAGE_ABOUT_MARKER');
    // And no <h1>: A's hero was the only one, and it belongs to A.
    expect(out).not.toContain('<h1');
  });

  it('never renders another page´s sections, even when handed them', () => {
    // The whole site's sections, as getSiteDetail returns them. The renderer
    // narrows to the page it was given, so a caller that forgets to filter
    // cannot produce a page showing another page's content.
    const everything = [...homeSections, ...innerSections];

    const onB = html(<SiteRenderer page={INNER} sections={everything} />);
    expect(onB).toContain('INNER_ABOUT_MARKER');
    expect(onB).toContain('INNER_SERVICES_MARKER');
    expect(onB).not.toContain('HOMEPAGE_HERO_MARKER');
    expect(onB).not.toContain('HOMEPAGE_ABOUT_MARKER');

    const onA = html(<SiteRenderer page={HOME} sections={everything} />);
    expect(onA).toContain('HOMEPAGE_HERO_MARKER');
    expect(onA).not.toContain('INNER_ABOUT_MARKER');
  });

  it('does not substitute another page when the supplied page has nothing', () => {
    // An empty page is empty. It is not an invitation to draw the homepage.
    const out = html(<SiteRenderer page={INNER} sections={homeSections} />);
    expect(out).not.toContain('HOMEPAGE_HERO_MARKER');
    expect(out).toContain('لا توجد أقسام بعد');
  });

  it('preserves page-local order', () => {
    const reversed = [innerSections[1]!, innerSections[0]!];
    // Order comes from the array the caller supplies — which getSiteDetail
    // sorted by (sort_order, id) and selectPage filtered, preserving it.
    const out = html(<SiteRenderer page={INNER} sections={reversed} />);
    expect(out.indexOf('INNER_SERVICES_MARKER')).toBeLessThan(
      out.indexOf('INNER_ABOUT_MARKER'),
    );
  });

  it('keeps hidden sections hidden on an inner page', () => {
    const withHidden = [
      innerSections[0]!,
      { ...innerSections[1]!, isVisible: false },
    ];
    const out = html(<SiteRenderer page={INNER} sections={withHidden} />);
    expect(out).toContain('INNER_ABOUT_MARKER');
    expect(out).not.toContain('INNER_SERVICES_MARKER');
  });

  it('renders an empty page safely', () => {
    const out = html(<SiteRenderer page={INNER} sections={[]} />);
    expect(out).toContain('لا توجد أقسام بعد');
    expect(out).toContain('dir="rtl"');
  });

  it('keeps theme, direction and CTA safety on an inner page', () => {
    const out = html(
      <SiteRenderer
        page={INNER}
        sections={[
          section(
            'hero',
            { title: 'INNER_HERO', ctaLabel: 'اذهب', ctaHref: 'javascript:alert(1)' },
            { id: 'b9', pageId: 'page-b' },
          ),
        ]}
        theme={{ primary: '#1e2fc8' }}
        direction="ltr"
      />,
    );
    expect(out).toContain('dir="ltr"');
    expect(out).toContain('--site-primary:30 47 200');
    // The unsafe target is dropped, exactly as on the homepage.
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('<a');
    expect(out).toContain('اذهب');
    // One hero, one h1.
    expect(out.match(/<h1/g)?.length).toBe(1);
  });

  it('still falls back for malformed content on an inner page', () => {
    const out = html(
      <SiteRenderer
        page={INNER}
        sections={[section('about', 'not an object', { id: 'b8', pageId: 'page-b' })]}
      />,
    );
    // Existing behaviour, unchanged: the section degrades to its placeholder.
    expect(out).toContain('من نحن');
    expect(out).toContain('لم تتم إضافة نص بعد.');
  });
});

/**
 * Data-bound sections (Phase 3).
 *
 * The renderer receives ALREADY-RESOLVED values. These tests hand it plain
 * objects — there is no database in reach of this file, which is the boundary
 * working rather than being asserted.
 */
describe('data-bound sections', () => {
  const P = page({ id: 'p1' });
  const menuSection = section('menu', { title: 'قائمتنا' }, { id: 'm1', pageId: 'p1' });

  const MENU: ResolvedSectionData = {
    type: 'menu',
    currency: 'EGP',
    categories: [
      {
        id: 'c1',
        name: 'المشروبات',
        products: [
          {
            id: 'p-latte',
            name: 'لاتيه',
            description: 'حليب وإسبريسو',
            imageUrl: null,
            fromPriceCents: 6500,
            variants: [
              { id: 'v1', name: 'وسط', priceCents: 6500 },
              { id: 'v2', name: 'كبير', priceCents: 8000 },
            ],
          },
        ],
      },
    ],
  };

  it('renders a resolved menu with its live prices', () => {
    const out = html(
      <SiteRenderer page={P} sections={[menuSection]} resolved={{ m1: MENU }} />,
    );
    expect(out).toContain('قائمتنا');
    expect(out).toContain('المشروبات');
    expect(out).toContain('لاتيه');
    // Arabic-Indic digits: the site's locale is ar-EG, so 6500 minor units
    // render as ٦٥ and not as 65.
    expect(out).toContain('٦٥');
    expect(out).toContain('٨٠');
    expect(out).toContain('EGP');
    expect(out).toContain('يبدأ من');
  });

  it('does not claim the menu belongs to a branch', () => {
    const out = html(
      <SiteRenderer page={P} sections={[menuSection]} resolved={{ m1: MENU }} />,
    );
    // A site is organization-scoped and no branch was selected, so the copy
    // must not imply one.
    expect(out).not.toContain('الفرع');
  });

  it('shows an unavailable notice when nothing was resolved', () => {
    // A page rendered without the resolver, or a resolution that failed. Never
    // a throw, and never stale data.
    const out = html(<SiteRenderer page={P} sections={[menuSection]} />);
    expect(out).toContain('قائمتنا');
    expect(out).toContain('تعذّر تحميل القائمة');
  });

  it('treats a mismatched resolved payload as absent', () => {
    const wrong: ResolvedSectionData = { type: 'hours', days: [] };
    const out = html(
      <SiteRenderer page={P} sections={[menuSection]} resolved={{ m1: wrong }} />,
    );
    expect(out).toContain('تعذّر تحميل القائمة');
  });

  it('renders an empty resolved menu as empty, not as an error', () => {
    const out = html(
      <SiteRenderer
        page={P}
        sections={[menuSection]}
        resolved={{ m1: { type: 'menu', currency: 'EGP', categories: [] } }}
      />,
    );
    expect(out).toContain('لم تتم إضافة أصناف بعد');
  });

  it('renders resolved business info, and never an address', () => {
    const s = section('business_info', {}, { id: 'bi', pageId: 'p1' });
    const out = html(
      <SiteRenderer
        page={P}
        sections={[s]}
        resolved={{
          bi: {
            type: 'business_info',
            name: 'Lavechi Café',
            phone: '0100',
            whatsapp: '0111',
            email: 'hi@lavechi.test',
            logoUrl: null,
          },
        }}
      />,
    );
    expect(out).toContain('Lavechi Café');
    expect(out).toContain('0100');
    expect(out).toContain('واتساب');
    // Organization-level info has no address; the branches section owns those.
    expect(out).not.toContain('العنوان');
    // Phone and email read left-to-right inside an RTL document.
    expect(out).toContain('dir="ltr"');
  });

  it('renders the seven-day schedule with no "open now" badge', () => {
    const s = section('hours', {}, { id: 'h1', pageId: 'p1' });
    const days = Array.from({ length: 7 }, (_, index) => ({
      index,
      closed: index === 6,
      opens: index === 6 ? null : '09:00',
      closes: index === 6 ? null : '23:00',
    }));
    const out = html(
      <SiteRenderer page={P} sections={[s]} resolved={{ h1: { type: 'hours', days } }} />,
    );
    expect(out).toContain('مواعيد العمل');
    expect(out).toContain('الإثنين');
    expect(out).toContain('الأحد');
    expect(out).toContain('09:00');
    expect(out).toContain('مغلق');
    // No competing "currently open" claim.
    expect(out).not.toContain('مفتوح الآن');
  });

  it('renders branches with their own addresses', () => {
    const s = section('branches', {}, { id: 'br', pageId: 'p1' });
    const out = html(
      <SiteRenderer
        page={P}
        sections={[s]}
        resolved={{
          br: {
            type: 'branches',
            branches: [
              { id: 'b1', name: 'الفرع الرئيسي', slug: 'main', address: 'شارع ٩', phone: '0100' },
              { id: 'b2', name: 'فرع المعادي', slug: 'maadi', address: 'المعادي', phone: null },
            ],
          },
        }}
      />,
    );
    expect(out).toContain('فروعنا');
    expect(out).toContain('شارع ٩');
    expect(out).toContain('المعادي');
  });

  it('keeps one h1 and page isolation with data-bound sections present', () => {
    const hero = section('hero', { title: 'HERO' }, { id: 'h0', pageId: 'p1' });
    const foreign = section('menu', {}, { id: 'other', pageId: 'page-elsewhere' });
    const out = html(
      <SiteRenderer
        page={P}
        sections={[hero, menuSection, foreign]}
        resolved={{ m1: MENU, other: MENU }}
      />,
    );
    expect(out.match(/<h1/g)?.length).toBe(1);
    // The foreign section is filtered by page, resolved data or not.
    expect(out.match(/قائمتنا/g)?.length).toBe(1);
  });

  it('keeps hidden data-bound sections hidden', () => {
    const hidden = { ...menuSection, isVisible: false };
    const out = html(
      <SiteRenderer page={P} sections={[hidden]} resolved={{ m1: MENU }} />,
    );
    expect(out).not.toContain('لاتيه');
  });
});
