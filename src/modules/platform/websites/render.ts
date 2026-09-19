import {
  parseSiteDefinition,
  type SiteDefinition,
  type SitePage,
} from './definition';
import { isSectionType, type Section, type SectionType } from './sections';

/**
 * Resolution — the half of rendering that has no JSX in it.
 *
 * `renderSite` in the conceptual sense is two steps, and they are separated on
 * purpose: this module decides WHAT a definition means, and the React
 * component decides how it looks. Keeping the decision here means preview, the
 * future published site and anything that renders an AI draft all reach the
 * same verdict, and that verdict is testable without rendering anything.
 *
 * The rule that matters: an unknown section type is dropped, never guessed at
 * and never thrown. A definition that reached storage cannot contain one — the
 * schema and the database both refuse it — so meeting one here means something
 * upstream changed, and the right answer is to draw the rest of the page and
 * report it, not to fail the whole site.
 */

export type ResolvedSection = { index: number; type: SectionType; props: unknown };

export type ResolvedPage = {
  slug: string;
  title: string;
  seo: { title: string; description?: string; noindex: boolean };
  sections: ResolvedSection[];
};

export type ResolvedSite = {
  definition: SiteDefinition;
  pages: ResolvedPage[];
  /** Section types that were dropped, so a preview can say so out loud. */
  skipped: { page: string; index: number; type: string }[];
};

export type RenderResult =
  | { ok: true; site: ResolvedSite }
  | { ok: false; error: string };

/**
 * Validate a stored or generated document and resolve it for rendering.
 *
 * Takes `unknown` deliberately. There is no overload that accepts a
 * SiteDefinition and skips the check: the whole value of this function is that
 * nothing renders without passing through it.
 */
export function resolveSite(definition: unknown): RenderResult {
  const parsed = parseSiteDefinition(definition);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const skipped: ResolvedSite['skipped'] = [];
  const pages = parsed.definition.pages.map((page) => resolvePage(page, skipped));

  return { ok: true, site: { definition: parsed.definition, pages, skipped } };
}

function resolvePage(page: SitePage, skipped: ResolvedSite['skipped']): ResolvedPage {
  const sections: ResolvedSection[] = [];

  page.sections.forEach((section: Section, index) => {
    if (!isSectionType(section.type)) {
      skipped.push({ page: page.slug, index, type: String(section.type) });
      return;
    }
    sections.push({ index, type: section.type, props: section.props });
  });

  return {
    slug: page.slug,
    title: page.title,
    seo: {
      // A page always has a title; SEO may override it but never remove it.
      title: page.seo?.title ?? page.title,
      description: page.seo?.description,
      noindex: page.seo?.noindex ?? false,
    },
    sections,
  };
}

/** The page a path resolves to, or null. Used by preview and, later, serving. */
export function findPage(site: ResolvedSite, slug: string): ResolvedPage | null {
  return site.pages.find((p) => p.slug === slug) ?? null;
}

/**
 * The theme as CSS custom properties.
 *
 * Every value here has already passed the hex pattern or a fixed-list enum, so
 * what reaches a style attribute can only be a colour or a known keyword. That
 * is why the definition refuses free text in the theme rather than escaping it.
 */
export function themeStyle(definition: SiteDefinition): Record<string, string> {
  const radius = { none: '0', small: '4px', medium: '10px', large: '18px', pill: '999px' };
  return {
    '--site-primary': definition.theme.colors.primary,
    '--site-secondary': definition.theme.colors.secondary,
    '--site-accent': definition.theme.colors.accent,
    '--site-bg': definition.theme.colors.background,
    '--site-text': definition.theme.colors.text,
    '--site-radius': radius[definition.theme.radius],
  };
}
