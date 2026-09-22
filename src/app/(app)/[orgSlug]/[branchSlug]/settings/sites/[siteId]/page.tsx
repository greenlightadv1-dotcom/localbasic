import Link from 'next/link';
import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { PageHeader } from '@/components/patterns/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { getLiveRevision, getSiteDetail, listRevisions } from '@/modules/sites/service';
import { draftDiffersFrom } from '@/modules/sites/publishing';
import { siteSettingsSchema } from '@/modules/sites/templates/types';
import { selectPage } from '@/modules/sites/pages';
import {
  CreatePageForm,
  DeletePageButton,
  AppearanceForm,
  GeneralForm,
  MoveButtons,
  PublishForm,
  RestoreButton,
  UnpublishButton,
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
  searchParams: {
    saved?: string;
    deleted?: string;
    error?: string;
    published?: string;
    restored?: string;
    unpublished?: string;
  };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  const detail = await getSiteDetail(ctx, params.siteId);

  // Null covers both "no such site" and "not this organization's" — the same
  // answer on purpose, so an id cannot be probed for which organization owns it.
  if (!detail) notFound();

  const { site, pages, sections, settings } = detail;
  const home = selectPage(detail, { kind: 'homepage' });
  const [live, revisions] = await Promise.all([
    getLiveRevision(ctx, site.id),
    listRevisions(ctx, site.id),
  ]);
  // A badge, not a guarantee: computed from what this screen already loaded.
  // The revision itself is the only authority on what is serving.
  const pendingChanges = live ? draftDiffersFrom(live.snapshot, { pages, sections }) : true;
  // Parsed, never trusted: a settings row written by hand or by an older build
  // falls back to the template's own values rather than reaching the form.
  const appearance = siteSettingsSchema.parse(settings?.settings ?? {});
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
      {searchParams.published && (
        <Alert tone="success">تم نشر النسخة {searchParams.published}.</Alert>
      )}
      {searchParams.restored && (
        <Alert tone="success">تمت إعادة نشر النسخة {searchParams.restored}.</Alert>
      )}
      {searchParams.unpublished && (
        <Alert tone="success">تم إيقاف نشر الموقع. السجل محفوظ.</Alert>
      )}

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

      {manage && (
        <Card>
          <CardHeader>
            <CardTitle>المظهر</CardTitle>
          </CardHeader>
          <CardBody>
            <AppearanceForm
              orgSlug={scope.orgSlug}
              branchSlug={scope.branchSlug}
              siteId={site.id}
              config={appearance}
            />
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>النشر</CardTitle>
            {manage && live && (
              <UnpublishButton
                orgSlug={scope.orgSlug}
                branchSlug={scope.branchSlug}
                siteId={site.id}
              />
            )}
          </div>
        </CardHeader>
        <CardBody className="space-y-4">
          {/* Live versus draft, stated in words rather than by colour alone. */}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {live ? (
              <>
                <Badge tone="success">منشور</Badge>
                <span className="text-muted">
                  النسخة {live.version} — نُشرت{' '}
                  <time dateTime={live.publishedAt} className="lb-numeric">
                    {new Date(live.publishedAt).toLocaleDateString('ar-EG')}
                  </time>
                </span>
                {pendingChanges ? (
                  <Badge tone="warn">توجد تغييرات غير منشورة</Badge>
                ) : (
                  <Badge tone="neutral">لا توجد تغييرات</Badge>
                )}
              </>
            ) : (
              <>
                <Badge tone="neutral">غير منشور</Badge>
                <span className="text-muted">لا توجد نسخة منشورة من هذا الموقع.</span>
              </>
            )}
          </div>

          {manage ? (
            <PublishForm
              orgSlug={scope.orgSlug}
              branchSlug={scope.branchSlug}
              siteId={site.id}
              hasLive={Boolean(live)}
              pendingChanges={pendingChanges}
            />
          ) : null}
        </CardBody>
      </Card>

      {revisions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>سجل النسخ</CardTitle>
          </CardHeader>
          <CardBody>
            <ul className="space-y-2">
              {revisions.map((revision) => (
                <li
                  key={revision.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-fg">
                      النسخة <span className="lb-numeric">{revision.version}</span>
                      {revision.isLive && (
                        <Badge tone="success" className="ms-2">
                          المنشورة الآن
                        </Badge>
                      )}
                    </p>
                    <p className="truncate text-xs text-muted">
                      <time dateTime={revision.publishedAt} className="lb-numeric">
                        {new Date(revision.publishedAt).toLocaleString('ar-EG')}
                      </time>
                      {revision.note ? ` · ${revision.note}` : ''}
                    </p>
                  </div>
                  {manage && !revision.isLive && (
                    <RestoreButton
                      orgSlug={scope.orgSlug}
                      branchSlug={scope.branchSlug}
                      siteId={site.id}
                      revisionId={revision.id}
                      version={revision.version}
                    />
                  )}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

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
