import { describe, expect, it } from 'vitest';
import { parseSiteDefinition, SITE_DEFINITION_VERSION } from './definition';
import { SECTION_TYPES, isSectionType } from './sections';
import { resolveSite } from './render';

/** A definition that must always be accepted; each test mutates a copy. */
function valid(): Record<string, unknown> {
  return {
    version: SITE_DEFINITION_VERSION,
    metadata: { name: 'مطعم لافيشي', locale: 'ar', direction: 'rtl' },
    theme: {
      colors: {
        primary: '#1E2FC8',
        secondary: '#6B8BFA',
        accent: '#1E2FC8',
        background: '#FFFFFF',
        text: '#111827',
      },
      fonts: { heading: 'cairo', body: 'cairo' },
      radius: 'medium',
      style: 'minimal',
    },
    navigation: [{ label: 'الرئيسية', target: '/' }],
    pages: [
      {
        slug: '/',
        title: 'الرئيسية',
        sections: [{ type: 'hero', props: { title: 'أهلًا' } }],
      },
    ],
    settings: { show_branding: true, analytics_enabled: false },
  };
}

/** Reach into a copy without fighting the type system in every test. */
function mutate(fn: (d: any) => void): Record<string, unknown> {
  const d = valid();
  fn(d);
  return d;
}

describe('site definition', () => {
  it('accepts a well-formed definition', () => {
    const result = parseSiteDefinition(valid());
    expect(result.ok).toBe(true);
  });

  // The version is what lets a future v2 change anything at all. A reader that
  // guessed at an unknown version would make that impossible.
  it('rejects an unsupported version', () => {
    const r = parseSiteDefinition(mutate((d) => { d.version = 2; }));
    expect(r.ok).toBe(false);
  });

  it('rejects an unknown section type', () => {
    const r = parseSiteDefinition(
      mutate((d) => { d.pages[0].sections[0].type = 'crypto_miner'; }),
    );
    expect(r.ok).toBe(false);
  });

  // Not sanitised — refused. Nothing downstream may treat stored text as HTML.
  it('rejects markup in any text', () => {
    const r = parseSiteDefinition(
      mutate((d) => { d.pages[0].sections[0].props.title = '<script>alert(1)</script>'; }),
    );
    expect(r.ok).toBe(false);
  });

  it('rejects a non-https image URL', () => {
    for (const bad of ['javascript:alert(1)', 'http://x.example/a.png', 'data:image/png;base64,AA']) {
      const r = parseSiteDefinition(
        mutate((d) => { d.pages[0].sections[0].props.image_url = bad; }),
      );
      expect(r.ok, bad).toBe(false);
    }
  });

  // A link a model chooses freely would make every generated page an open
  // redirect, so a destination can only ever be a path of this same site.
  it('rejects a navigation target that leaves the site', () => {
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example']) {
      const r = parseSiteDefinition(mutate((d) => { d.navigation[0].target = bad; }));
      expect(r.ok, bad).toBe(false);
    }
  });

  it('rejects navigation pointing at a page that does not exist', () => {
    const r = parseSiteDefinition(mutate((d) => { d.navigation[0].target = '/nowhere'; }));
    expect(r.ok).toBe(false);
  });

  it('rejects a theme colour that is not a hex literal', () => {
    const r = parseSiteDefinition(
      mutate((d) => { d.theme.colors.primary = 'red; background: url(x)'; }),
    );
    expect(r.ok).toBe(false);
  });

  it('rejects a font outside the fixed list', () => {
    const r = parseSiteDefinition(mutate((d) => { d.theme.fonts.body = 'Comic Sans'; }));
    expect(r.ok).toBe(false);
  });

  it('requires a home page', () => {
    const r = parseSiteDefinition(mutate((d) => { d.pages[0].slug = '/about'; }));
    expect(r.ok).toBe(false);
  });

  it('rejects duplicate page slugs', () => {
    const r = parseSiteDefinition(
      mutate((d) => { d.pages.push({ ...d.pages[0] }); }),
    );
    expect(r.ok).toBe(false);
  });

  // An unknown key is an error, not something quietly carried into a snapshot
  // for a future renderer to discover.
  it('rejects unknown keys on a section', () => {
    const r = parseSiteDefinition(
      mutate((d) => { d.pages[0].sections[0].props.html = '<b>x</b>'; }),
    );
    expect(r.ok).toBe(false);
  });

  it('rejects a definition that is not an object', () => {
    for (const bad of [null, 'a string', 42, []]) {
      expect(parseSiteDefinition(bad).ok, String(bad)).toBe(false);
    }
  });
});

describe('section registry', () => {
  it('recognises exactly the registered types', () => {
    expect(SECTION_TYPES.length).toBeGreaterThan(0);
    for (const t of SECTION_TYPES) expect(isSectionType(t)).toBe(true);
    for (const bad of ['script', 'iframe', '', 'HERO']) expect(isSectionType(bad)).toBe(false);
  });
});

describe('renderer resolution', () => {
  it('resolves a valid definition into pages', () => {
    const result = resolveSite(valid());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.site.pages).toHaveLength(1);
    expect(result.site.pages[0]!.sections[0]!.type).toBe('hero');
    expect(result.site.skipped).toHaveLength(0);
  });

  // The renderer refuses invalid input rather than drawing part of it. There
  // is deliberately no path that renders a document this did not accept.
  it('refuses to resolve an invalid definition', () => {
    const r = resolveSite(mutate((d) => { d.pages[0].sections[0].type = 'unknown'; }));
    expect(r.ok).toBe(false);
  });

  it('falls back to the page title for SEO', () => {
    const r = resolveSite(valid());
    expect(r.ok && r.site.pages[0]!.seo.title).toBe('الرئيسية');
  });
});
