import Link from 'next/link';
import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { PageHeader } from '@/components/patterns/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getSiteDetail } from '@/modules/sites/service';
import { SECTION_LABELS } from '@/modules/sites/schemas';
import { selectPage } from '@/modules/sites/pages';

export const metadata = { title: 'تفاصيل الموقع' };
export const dynamic = 'force-dynamic';

export default async function SiteDetailPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string; siteId: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  const detail = await getSiteDetail(ctx, params.siteId);

  // Null covers both "no such site" and "not this organization's" — the same
  // answer on purpose, so an id cannot be probed for which organization owns it.
  if (!detail) notFound();

  const { site, pages, sections, settings } = detail;
  // The same selection the preview uses, so "which page does a site open on"
  // is answered in one place rather than re-derived per screen.
  const home = selectPage(detail, { kind: 'homepage' });
  const homepage = home.ok ? home.page : null;
  const base = `/${ctx.organizationSlug}/${ctx.branchSlug}/settings/sites`;

  return (
    <div className="space-y-5">
      <PageHeader
        title={site.name}
        description={`المعرّف: ${site.slug}`}
        actions={
          <>
            <Link href={`${base}/${site.id}/preview`}>
              <Button variant="outline" size="sm">
                معاينة
              </Button>
            </Link>
            <Link href={base}>
              <Button variant="ghost" size="sm">
                كل المواقع
              </Button>
            </Link>
          </>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>الحالة</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-wrap items-center gap-3 text-sm text-muted">
          <Badge tone={site.status === 'published' ? 'success' : 'neutral'}>
            {site.status === 'published' ? 'منشور' : 'مسودة'}
          </Badge>
          <span>
            {pages.length} صفحة · {sections.length} قسم
          </span>
          <span>{settings ? 'الإعدادات جاهزة' : 'لا توجد إعدادات'}</span>
          {can(ctx, 'site.manage') ? null : <Badge tone="info">للعرض فقط</Badge>}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>الصفحات</CardTitle>
        </CardHeader>
        <CardBody>
          {pages.length === 0 ? (
            <p className="text-sm text-muted">لا توجد صفحات.</p>
          ) : (
            <ul className="space-y-2">
              {pages.map((page) => (
                <li
                  key={page.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-fg">{page.title}</p>
                    <p className="truncate text-xs text-muted" dir="ltr">
                      /{page.slug}
                    </p>
                  </div>
                  {page.isHomepage && <Badge tone="info">الرئيسية</Badge>}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>أقسام {homepage ? homepage.title : 'الصفحة'}</CardTitle>
        </CardHeader>
        <CardBody>
          {(() => {
            const own = home.ok ? home.sections : [];
            if (own.length === 0) {
              return (
                <p className="text-sm text-muted">
                  لا توجد أقسام بعد. لوحة التحرير ستأتي في مرحلة لاحقة.
                </p>
              );
            }
            return (
              <ul className="space-y-2">
                {own.map((section) => (
                  <li
                    key={section.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                  >
                    <span className="text-sm text-fg">
                      {SECTION_LABELS[section.sectionType]}
                    </span>
                    {!section.isVisible && <Badge tone="warn">مخفي</Badge>}
                  </li>
                ))}
              </ul>
            );
          })()}
        </CardBody>
      </Card>
    </div>
  );
}
