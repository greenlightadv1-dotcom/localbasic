import Link from 'next/link';
import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { PageHeader } from '@/components/patterns/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { getSiteDetail } from '@/modules/sites/service';
import { selectPage } from '@/modules/sites/pages';
import {
  CreatePageForm,
  DeletePageButton,
  GeneralForm,
  MoveButtons,
} from './forms';

export const metadata = { title: 'تفاصيل الموقع' };
export const dynamic = 'force-dynamic';

/**
 * A site's general settings and its pages.
 *
 * Reading needs `site.read`; every control on the screen posts to a Server
 * Action that re-checks `site.manage`. A viewer sees the site and is offered
 * nothing to press — and the server would refuse a forged submission anyway.
 */
export default async function SiteDetailPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; branchSlug: string; siteId: string };
  searchParams: { saved?: string; deleted?: string; error?: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  const detail = await getSiteDetail(ctx, params.siteId);

  // Null covers both "no such site" and "not this organization's" — the same
  // answer on purpose, so an id cannot be probed for which organization owns it.
  if (!detail) notFound();

  const { site, pages, sections, settings } = detail;
  const home = selectPage(detail, { kind: 'homepage' });
  const manage = can(ctx, 'site.manage');
  const base = `/${ctx.organizationSlug}/${ctx.branchSlug}/settings/sites`;
  const scope = { orgSlug: ctx.organizationSlug, branchSlug: ctx.branchSlug };

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

      {searchParams.error && <Alert tone="danger">{searchParams.error}</Alert>}
      {searchParams.saved && <Alert tone="success">تم حفظ التغييرات.</Alert>}
      {searchParams.deleted && <Alert tone="success">تم حذف الصفحة.</Alert>}

      {!manage && (
        <Alert tone="info">
          لديك صلاحية العرض فقط. التحرير يتطلّب صلاحية إدارة المواقع.
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>الإعدادات العامة</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
            <Badge tone={site.status === 'published' ? 'success' : 'neutral'}>
              {site.status === 'published' ? 'منشور' : 'مسودة'}
            </Badge>
            <span>
              {pages.length} صفحة · {sections.length} قسم
            </span>
            <span>{settings ? 'الإعدادات جاهزة' : 'لا توجد إعدادات'}</span>
          </div>

          {manage ? (
            <GeneralForm
              orgSlug={scope.orgSlug}
              branchSlug={scope.branchSlug}
              siteId={site.id}
              name={site.name}
              status={site.status}
            />
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>الصفحات</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          {pages.length === 0 ? (
            <p className="text-sm text-muted">لا توجد صفحات.</p>
          ) : (
            <ul className="space-y-2">
              {pages.map((p, index) => {
                const count = sections.filter((s) => s.pageId === p.id).length;
                return (
                  <li
                    key={p.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`${base}/${site.id}/pages/${p.id}`}
                        className="inline-flex min-h-11 items-center font-semibold text-fg underline-offset-4 hover:underline"
                      >
                        {p.title}
                      </Link>
                      <p className="truncate text-xs text-muted" dir="ltr">
                        /{p.slug} · {count} قسم
                      </p>
                    </div>

                    {/* Not colour alone: the homepage says so. */}
                    {p.isHomepage && <Badge tone="info">الرئيسية</Badge>}

                    {manage && (
                      <div className="flex flex-wrap items-center gap-1">
                        <MoveButtons
                          orgSlug={scope.orgSlug}
                          branchSlug={scope.branchSlug}
                          siteId={site.id}
                          pageId={p.id}
                          label={p.title}
                          isFirst={index === 0}
                          isLast={index === pages.length - 1}
                        />
                        <DeletePageButton
                          orgSlug={scope.orgSlug}
                          branchSlug={scope.branchSlug}
                          siteId={site.id}
                          pageId={p.id}
                          title={p.title}
                          isHomepage={p.isHomepage}
                          isOnlyPage={pages.length === 1}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {home.ok && home.viaHomepageFallback && (
            <Alert tone="warn">
              لا توجد صفحة رئيسية محدّدة. يتم عرض أول صفحة مؤقتًا.
            </Alert>
          )}
        </CardBody>
      </Card>

      {manage && (
        <Card>
          <CardHeader>
            <CardTitle>إضافة صفحة</CardTitle>
          </CardHeader>
          <CardBody>
            <CreatePageForm
              orgSlug={scope.orgSlug}
              branchSlug={scope.branchSlug}
              siteId={site.id}
            />
          </CardBody>
        </Card>
      )}
    </div>
  );
}
