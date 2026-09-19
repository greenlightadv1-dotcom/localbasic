import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getWebsite, listVersions } from '@/modules/platform/websites/service';
import { resolveSite } from '@/modules/platform/websites/render';
import { SiteRenderer } from '@/components/website/site-renderer';
import { adminMetadata } from '@/modules/platform/admin/metadata';
import { AdminHeading, Panel, formatDate } from '../../ui';
import { PublishControls, BriefForm } from './controls';

export const generateMetadata = adminMetadata('الموقع');
export const dynamic = 'force-dynamic';

export default async function WebsiteDetailPage({ params }: { params: { id: string } }) {
  const website = await getWebsite(params.id);
  if (!website) notFound();

  const versions = await listVersions(website.id);

  // Preview always renders the DRAFT: the point of a draft is to see it before
  // anyone else does. The published copy is shown only as a state, never mixed
  // into this view, so the two can never be confused.
  const preview = website.draftDefinition ? resolveSite(website.draftDefinition) : null;
  const home = preview?.ok ? (preview.site.pages.find((p) => p.slug === '/') ?? null) : null;

  return (
    <>
      <AdminHeading
        title={website.name}
        lead={`${website.organizationName} · /${website.slug}`}
      />

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Panel className="overflow-hidden">
          <div className="border-b border-line px-4 py-2 text-xs font-semibold text-muted">
            معاينة المسودة
          </div>

          {website.draftError ? (
            <p className="p-6 text-sm text-danger">
              المسودة المحفوظة لم تعد صالحة: {website.draftError}
            </p>
          ) : preview?.ok && home && website.draftDefinition ? (
            <>
              {preview.site.skipped.length > 0 && (
                <p className="border-b border-line bg-warn/10 px-4 py-2 text-xs text-warn">
                  تم تجاهل {preview.site.skipped.length} قسمًا غير معروف.
                </p>
              )}
              <div className="max-h-[32rem] overflow-y-auto">
                <SiteRenderer definition={website.draftDefinition} page={home} />
              </div>
            </>
          ) : (
            <p className="p-6 text-sm text-muted">لا توجد صفحة رئيسية لعرضها.</p>
          )}
        </Panel>

        <div className="space-y-4">
          <Panel className="p-5">
            <h2 className="mb-3 text-sm font-bold text-fg">الحالة</h2>
            <dl className="space-y-2 text-xs">
              <div className="flex justify-between">
                <dt className="text-muted">الحالة</dt>
                <dd className="font-semibold text-fg">{website.status}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">النوع</dt>
                <dd className="font-semibold text-fg">{website.siteType}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">أُنشئ</dt>
                <dd className="text-fg">{formatDate(website.createdAt)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">آخر نشر</dt>
                <dd className="text-fg">
                  {website.publishedAt ? formatDate(website.publishedAt) : '—'}
                </dd>
              </div>
            </dl>
            <PublishControls id={website.id} status={website.status} />
          </Panel>

          <Panel className="p-5">
            <h2 className="mb-3 text-sm font-bold text-fg">الإصدارات المنشورة</h2>
            {versions.length === 0 ? (
              <p className="text-xs text-muted">لم يُنشر هذا الموقع بعد.</p>
            ) : (
              <ul className="space-y-2 text-xs">
                {versions.map((v) => (
                  <li key={v.version} className="flex justify-between border-b border-line pb-2 last:border-0">
                    <span className="font-semibold text-fg">إصدار {v.version}</span>
                    <span className="text-muted">{formatDate(v.publishedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      <Panel className="mt-4 p-5">
        <h2 className="mb-3 text-sm font-bold text-fg">تعليمات التوليد</h2>
        <p className="mb-4 text-xs text-muted">
          تُحفظ هنا ويستهلكها مولّد المحتوى في المرحلة التالية.
        </p>
        <BriefForm id={website.id} brief={website.brief} />
      </Panel>

      <p className="mt-4 text-xs text-muted">
        <Link href="/admin/websites" className="text-primary hover:underline">
          ← كل المواقع
        </Link>
      </p>
    </>
  );
}
