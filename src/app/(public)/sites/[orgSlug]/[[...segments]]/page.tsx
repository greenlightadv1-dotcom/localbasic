import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SiteRenderer } from '@/modules/sites/renderer';
import { getPublicSitePage, resolvePublicSectionData } from '@/modules/sites/public';
import { siteSettingsSchema } from '@/modules/sites/templates/types';
import { resolveTemplate } from '@/modules/sites/templates';

/**
 * A Site Engine site, at its LocalBasic address.
 *
 * No session, no membership, nothing tenant-scoped: this is the surface a
 * customer's visitor actually reaches. Structure and authorization both come
 * from getPublicSitePage(), which only ever returns a PUBLISHED site — a
 * draft site, or an organization with none, is not found here exactly as it
 * would be for a made-up slug (see 0062_site_engine_public.sql).
 *
 * `[[...segments]]` takes at most one segment, a page slug: `/sites/lavechi`
 * is the homepage, `/sites/lavechi/about` is the page whose slug is `about`.
 * Anything deeper is not a Site Engine path.
 */
export const dynamic = 'force-dynamic';

type Params = { params: { orgSlug: string; segments?: string[] } };

function pageSlugFrom(segments?: string[]): string | null | false {
  if (!segments || segments.length === 0) return null;
  if (segments.length > 1) return false;
  return segments[0]!.toLowerCase();
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const slug = pageSlugFrom(params.segments);
  if (slug === false) return { title: 'الصفحة غير موجودة', robots: { index: false, follow: false } };

  const site = await getPublicSitePage(params.orgSlug, slug);
  if (!site) return { title: 'الصفحة غير موجودة', robots: { index: false, follow: false } };

  return {
    title: site.page.isHomepage ? site.siteName : `${site.page.title} — ${site.siteName}`,
    robots: { index: true, follow: true },
  };
}

export default async function PublicSitePage({ params }: Params) {
  const slug = pageSlugFrom(params.segments);
  if (slug === false) notFound();

  const site = await getPublicSitePage(params.orgSlug, slug);
  if (!site) notFound();

  const config = siteSettingsSchema.parse(site.settings);
  const template = resolveTemplate(config.templateId);
  const theme = { ...template.theme, ...config.theme };

  const resolved = await resolvePublicSectionData(params.orgSlug, site.sections);

  return (
    <div dir={config.direction}>
      {site.pages.length > 1 && (
        <nav
          aria-label={config.direction === 'rtl' ? 'صفحات الموقع' : 'Site pages'}
          className="flex flex-wrap gap-2 border-b border-[rgb(var(--site-border,229_231_235))] px-5 py-3"
        >
          {site.pages.map((p) => {
            const current = p.id === site.page.id;
            const href = p.isHomepage
              ? `/sites/${params.orgSlug}`
              : `/sites/${params.orgSlug}/${p.slug}`;
            return (
              <Link
                key={p.id}
                href={href}
                aria-current={current ? 'page' : undefined}
                className={`inline-flex min-h-11 items-center rounded-lg px-3 text-sm ${
                  current ? 'font-semibold' : 'opacity-70 hover:opacity-100'
                }`}
              >
                {p.title}
              </Link>
            );
          })}
        </nav>
      )}

      <SiteRenderer
        page={site.page}
        sections={site.sections}
        theme={theme}
        direction={config.direction}
        resolved={resolved}
      />
    </div>
  );
}
