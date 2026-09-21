import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { SiteRenderer } from '@/modules/sites/renderer';
import { getSiteDetail } from '@/modules/sites/service';
import { requireSignedIn } from '@/modules/sites/guard';

export const metadata = { title: 'معاينة الموقع' };
export const dynamic = 'force-dynamic';

/**
 * Preview, not publication.
 *
 * Authenticated and owner-only: the same getSiteDetail() the details screen
 * uses, so RLS decides. A site's public address is a later phase — this route
 * exists so an owner can see what the renderer makes of their data, and it
 * deliberately does not serve anyone else's site to anyone.
 */
export default async function SitePreviewPage({
  params,
}: {
  params: { siteId: string };
}) {
  await requireSignedIn();
  const detail = await getSiteDetail(params.siteId);
  if (!detail) notFound();

  const { site, pages, sections } = detail;
  const homepage = pages.find((p) => p.isHomepage) ?? pages[0] ?? null;
  const pageSections = homepage
    ? sections.filter((s) => s.pageId === homepage.id)
    : [];

  return (
    <div className="min-h-dvh bg-bg">
      {/* Deliberately outside the rendered site: a preview must be obviously a
          preview, and the way back must not depend on browser history. */}
      <div className="flex items-center justify-between gap-3 border-b border-border bg-surface px-4 py-2">
        <p className="truncate text-sm text-muted">
          معاينة: <span className="font-semibold text-fg">{site.name}</span>
        </p>
        <Link href={`/sites/${site.id}`}>
          <Button variant="outline" size="sm">
            رجوع
          </Button>
        </Link>
      </div>

      <main className="mx-auto w-full max-w-3xl">
        <SiteRenderer sections={pageSections} />
      </main>
    </div>
  );
}
