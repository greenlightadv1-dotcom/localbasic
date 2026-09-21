import Link from 'next/link';
import { notFound } from 'next/navigation';
import { resolveTenantContext } from '@/modules/core/tenancy/context';
import { Button } from '@/components/ui/button';
import { SiteRenderer } from '@/modules/sites/renderer';
import { getSiteDetail } from '@/modules/sites/service';
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
 */
export default async function SitePreviewPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string; siteId: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  const detail = await getSiteDetail(ctx, params.siteId);
  if (!detail) notFound();

  const { site, pages, sections, settings } = detail;
  const homepage = pages.find((p) => p.isHomepage) ?? pages[0] ?? null;
  const pageSections = homepage ? sections.filter((s) => s.pageId === homepage.id) : [];
  const base = `/${ctx.organizationSlug}/${ctx.branchSlug}/settings/sites`;

  // Parsed, never trusted: a settings row can be written by hand, or by a
  // build that had different fields. Anything unusable falls back to the
  // template's own theme rather than reaching a style attribute.
  const config = siteSettingsSchema.parse(settings?.settings ?? {});
  const template = resolveTemplate(config.templateId);
  const theme = { ...template.theme, ...config.theme };

  return (
    <div className="space-y-4">
      {/* Deliberately outside the rendered site: a preview must be obviously a
          preview, and the way back must not depend on browser history. */}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-2">
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

      {/* The rendered site is isolated from the application chrome: its own
          direction and its own colour variables, so a template's theme cannot
          leak into the dashboard around it. */}
      <div className="overflow-hidden rounded-xl border border-border">
        <SiteRenderer
          sections={pageSections}
          theme={theme}
          direction={config.direction}
        />
      </div>
    </div>
  );
}
