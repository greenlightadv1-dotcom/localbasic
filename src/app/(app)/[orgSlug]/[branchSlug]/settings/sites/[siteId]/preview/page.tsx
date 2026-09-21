import Link from 'next/link';
import { notFound } from 'next/navigation';
import { resolveTenantContext } from '@/modules/core/tenancy/context';
import { Button } from '@/components/ui/button';
import { SiteRenderer } from '@/modules/sites/renderer';
import { getSiteDetail } from '@/modules/sites/service';

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

  const { site, pages, sections } = detail;
  const homepage = pages.find((p) => p.isHomepage) ?? pages[0] ?? null;
  const pageSections = homepage ? sections.filter((s) => s.pageId === homepage.id) : [];
  const base = `/${ctx.organizationSlug}/${ctx.branchSlug}/settings/sites`;

  return (
    <div className="space-y-4">
      {/* Deliberately outside the rendered site: a preview must be obviously a
          preview, and the way back must not depend on browser history. */}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-2">
        <p className="truncate text-sm text-muted">
          معاينة: <span className="font-semibold text-fg">{site.name}</span>
        </p>
        <Link href={`${base}/${site.id}`}>
          <Button variant="outline" size="sm">
            رجوع
          </Button>
        </Link>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-bg">
        <SiteRenderer sections={pageSections} />
      </div>
    </div>
  );
}
