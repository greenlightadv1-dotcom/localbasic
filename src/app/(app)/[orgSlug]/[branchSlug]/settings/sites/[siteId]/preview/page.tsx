import Link from 'next/link';
import { notFound } from 'next/navigation';
import { resolveTenantContext } from '@/modules/core/tenancy/context';
import { Button } from '@/components/ui/button';
import { SiteRenderer } from '@/modules/sites/renderer';
import { getSiteDetail } from '@/modules/sites/service';
import { pageSelectionFromParam, selectPage } from '@/modules/sites/pages';
import { resolveSectionData } from '@/modules/sites/resolve';
import { siteSettingsSchema } from '@/modules/sites/templates/types';
import { resolveTemplate } from '@/modules/sites/templates';

export const metadata = { title: 'معاينة الموقع' };
export const dynamic = 'force-dynamic';

/**
 * Preview, not publication.
 *
 * Behind the same tenant context and `site.read` as the details screen, so a
 * preview is never a way to see a site the caller could not otherwise open.
 * Public hosting is a later phase; this exists so a member can see what the
 * renderer makes of their data.
 *
 * READ-ONLY. Switching pages is a link with a query string — a GET, no action,
 * no mutation. Nothing on this screen writes.
 *
 * `?page=<id>` names a page. The id is resolved INSIDE the already-authorized
 * site: getSiteDetail() returns this organization's site or nothing, and
 * selectPage() searches that result. No id from the URL is ever used to fetch a
 * page and then checked afterwards for which site owns it, so an id belonging
 * to another site is simply absent and answers not-found — the same answer a
 * typo gets.
 */
export default async function SitePreviewPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; branchSlug: string; siteId: string };
  searchParams: { page?: string | string[] };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  const detail = await getSiteDetail(ctx, params.siteId);
  if (!detail) notFound();

  const { site, pages, settings } = detail;
  const base = `/${ctx.organizationSlug}/${ctx.branchSlug}/settings/sites`;

  // Parsed, never trusted: a settings row can be written by hand, or by a
  // build that had different fields. Anything unusable falls back to the
  // template's own theme rather than reaching a style attribute.
  const config = siteSettingsSchema.parse(settings?.settings ?? {});
  const template = resolveTemplate(config.templateId);
  const theme = { ...template.theme, ...config.theme };

  const selection = pageSelectionFromParam(searchParams.page);
  const selected = selectPage(detail, selection);

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-2">
      <p className="truncate text-sm text-muted">
        معاينة: <span className="font-semibold text-fg">{site.name}</span>
        <span className="ms-2 text-xs">· قالب {template.nameAr}</span>
      </p>
      <Link href={`${base}/${site.id}`}>
        <Button variant="outline" size="sm">
          رجوع
        </Button>
      </Link>
    </div>
  );

  // A page was named and this site does not have it. Said plainly rather than
  // quietly redrawing the homepage, which would make a stale link look like a
  // working one.
  if (!selected.ok) {
    return (
      <div className="space-y-4">
        {header}
        <div className="rounded-xl border border-border px-6 py-16 text-center">
          <p className="font-semibold text-fg">
            {selected.reason === 'site-has-no-pages'
              ? 'لا توجد صفحات في هذا الموقع'
              : 'الصفحة المطلوبة غير موجودة'}
          </p>
          <p className="mt-1 text-sm text-muted">
            {selected.reason === 'site-has-no-pages'
              ? 'أضف صفحة أولًا لتتمكن من المعاينة.'
              : 'قد تكون الصفحة حُذفت أو يكون الرابط قديمًا.'}
          </p>
          {selected.reason === 'unknown-page' && (
            <Link href={`${base}/${site.id}/preview`} className="mt-4 inline-block">
              <Button variant="outline" size="sm">
                معاينة الصفحة الرئيسية
              </Button>
            </Link>
          )}
        </div>
      </div>
    );
  }

  // Live business data for this page's data-bound sections, resolved on the
  // server against the SAME authorized tenant context that loaded the site.
  // Nothing in section content chooses the organization — see resolve.ts.
  const resolved = await resolveSectionData(ctx, selected.sections);

  return (
    <div className="space-y-4">
      {/* Deliberately outside the rendered site: a preview must be obviously a
          preview, and the way back must not depend on browser history. */}
      {header}

      {/* The page switcher. A row of links, not an editor: each one is a GET
          that re-renders this screen for a different page. Shown only when
          there is more than one page, because a switcher over one page is
          just noise. */}
      {pages.length > 1 && (
        <nav
          aria-label="صفحات الموقع"
          className="flex flex-wrap gap-2 rounded-lg border border-border bg-surface px-3 py-2"
        >
          {pages.map((p) => {
            const current = p.id === selected.page.id;
            return (
              <Link
                key={p.id}
                href={
                  p.isHomepage
                    ? `${base}/${site.id}/preview`
                    : `${base}/${site.id}/preview?page=${encodeURIComponent(p.id)}`
                }
                aria-current={current ? 'page' : undefined}
                className={`inline-flex min-h-11 items-center rounded-lg px-3 text-sm ${
                  current
                    ? 'bg-fg/10 font-semibold text-fg'
                    : 'text-muted hover:bg-fg/5 hover:text-fg'
                }`}
              >
                {p.title}
                {p.isHomepage && <span className="ms-1 text-xs">· الرئيسية</span>}
              </Link>
            );
          })}
        </nav>
      )}

      {/* The selected page's own title, not the site's name and not the
          homepage's. Outside the rendered markup, so the page's single <h1>
          stays the hero's. */}
      <p className="px-1 text-sm text-muted">
        الصفحة: <span className="font-semibold text-fg">{selected.page.title}</span>
        <span className="ms-2 text-xs" dir="ltr">
          /{selected.page.slug}
        </span>
      </p>

      {/* The rendered site is isolated from the application chrome: its own
          direction and its own colour variables, so a template's theme cannot
          leak into the dashboard around it. */}
      <div className="overflow-hidden rounded-xl border border-border">
        <SiteRenderer
          page={selected.page}
          sections={selected.sections}
          theme={theme}
          direction={config.direction}
          resolved={resolved}
        />
      </div>
    </div>
  );
}
