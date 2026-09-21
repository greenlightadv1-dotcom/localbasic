import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/patterns/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getSiteDetail } from '@/modules/sites/service';
import { requireSignedIn } from '@/modules/sites/guard';
import { SECTION_LABELS } from '@/modules/sites/schemas';

export const metadata = { title: 'تفاصيل الموقع' };
export const dynamic = 'force-dynamic';

export default async function SiteDetailPage({
  params,
}: {
  params: { siteId: string };
}) {
  await requireSignedIn();
  const detail = await getSiteDetail(params.siteId);

  // Null means RLS filtered it out, which is the same answer as "no such
  // site" — and deliberately so. Saying "exists, but not yours" would confirm
  // the id belongs to someone.
  if (!detail) notFound();

  const { site, pages, sections, settings } = detail;
  const homepage = pages.find((p) => p.isHomepage) ?? pages[0] ?? null;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8">
      <PageHeader
        title={site.name}
        description={`المعرّف: ${site.slug}`}
        actions={
          <Link href={`/sites/${site.id}/preview`}>
            <Button variant="outline" size="sm">
              معاينة
            </Button>
          </Link>
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
            const own = homepage
              ? sections.filter((s) => s.pageId === homepage.id)
              : [];
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
