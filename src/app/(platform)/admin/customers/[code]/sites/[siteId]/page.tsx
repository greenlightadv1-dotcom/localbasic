import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getOrganizationByCode } from '@/modules/platform/billing/service';
import {
  platformGetSiteDetail,
  platformListRevisions,
} from '@/modules/platform/sites/service';
import { resolveSectionData } from '@/modules/sites/resolve';
import { SiteRenderer } from '@/modules/sites/renderer';
import type { SitePage, SiteSection } from '@/modules/sites/types';
import { draftDiffersFrom, type SnapshotPage } from '@/modules/sites/publishing';
import { AdminHeading, Panel, CustomerCode } from '../../../../ui';
import {
  PublishForm,
  RestoreButton,
  UnpublishButton,
} from '@/app/(app)/[orgSlug]/[branchSlug]/settings/sites/[siteId]/forms';
import {
  platformPublishSiteAction,
  platformRollbackSiteAction,
  platformUnpublishSiteAction,
} from './actions';

export async function generateMetadata({ params }: { params: { code: string; siteId: string } }) {
  return { title: 'موقع العميل', robots: { index: false, follow: false } };
}

export const dynamic = 'force-dynamic';

/** A draft page's sections, adapted from the snapshot into the renderer's read model. */
function pageAndSections(page: SnapshotPage, siteId: string): { page: SitePage; sections: SiteSection[] } {
  return {
    page: {
      id: page.id,
      siteId,
      title: page.title,
      slug: page.slug,
      isHomepage: page.isHomepage,
      sortOrder: page.sortOrder,
    },
    sections: page.sections.map((s) => ({
      id: s.id,
      pageId: page.id,
      sectionType: s.sectionType,
      content: s.content,
      sortOrder: s.sortOrder,
      isVisible: true,
    })),
  };
}

/**
 * Site Engine, operated by Platform Admin: a read-only view of the SAME
 * site an organization's own editor shows, plus the publishing controls.
 *
 * Reused, not rebuilt: PublishForm, RestoreButton and UnpublishButton are the
 * exact components the tenant editor renders, given Platform Admin's own
 * actions instead of the tenant ones. The preview below is the SAME
 * SiteRenderer + resolveSectionData the tenant preview route uses, fed the
 * organization's own id/name/currency rather than a TenantContext a Platform
 * Admin session does not have.
 *
 * There is no page or section editor here on purpose — see 0061's own
 * comment for why. Content stays the organization's own authority; theme is
 * the Theme Customizer, one link away.
 */
export default async function PlatformSiteDetailPage({
  params,
  searchParams,
}: {
  params: { code: string; siteId: string };
  searchParams: { published?: string; restored?: string; unpublished?: string; error?: string };
}) {
  const code = decodeURIComponent(params.code);
  const org = await getOrganizationByCode(code);
  if (!org) notFound();

  const detail = await platformGetSiteDetail(code, params.siteId);
  if (!detail) notFound();

  const revisions = await platformListRevisions(code, params.siteId);
  const home = detail.snapshot.pages.find((p) => p.isHomepage) ?? detail.snapshot.pages[0];
  const resolveCtx = {
    organizationId: detail.organization.id,
    organizationName: detail.organization.name,
    currency: detail.organization.currency,
  };
  const preview = home ? pageAndSections(home, detail.site.id) : null;
  const resolved = preview
    ? await resolveSectionData(resolveCtx, preview.sections)
    : undefined;

  // Same comparison the tenant editor makes (draftDiffersFrom), against the
  // draft this screen already loaded rather than an unpublished one.
  const draftFlat = detail.snapshot.pages.flatMap((p) => pageAndSections(p, detail.site.id).sections);
  const pendingChanges = detail.live
    ? draftDiffersFrom(detail.live.snapshot, {
        pages: detail.snapshot.pages.map((p) => ({
          id: p.id, title: p.title, slug: p.slug, isHomepage: p.isHomepage,
        })),
        sections: draftFlat,
      })
    : true;

  const base = `/admin/customers/${encodeURIComponent(code)}/sites`;

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-4 py-8">
      <AdminHeading title={detail.site.name} lead={`${org.name} · ${detail.site.slug}`} />

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <CustomerCode code={org.customerCode} />
        <Link href={base} className="text-primary hover:underline">
          كل مواقع العميل
        </Link>
        <Link
          href={`${base}/${detail.site.id}/theme`}
          className="ms-auto rounded bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg hover:bg-primary/90"
        >
          فتح مخصّص المظهر
        </Link>
      </div>

      {searchParams.error && (
        <Panel className="border-danger/40 bg-danger/5 px-4 py-3 text-sm text-danger">
          {searchParams.error}
        </Panel>
      )}
      {searchParams.published && (
        <Panel className="border-success/40 bg-success/5 px-4 py-3 text-sm text-success">
          تم نشر النسخة {searchParams.published}.
        </Panel>
      )}
      {searchParams.restored && (
        <Panel className="border-success/40 bg-success/5 px-4 py-3 text-sm text-success">
          تمت إعادة نشر النسخة {searchParams.restored}.
        </Panel>
      )}
      {searchParams.unpublished && (
        <Panel className="border-success/40 bg-success/5 px-4 py-3 text-sm text-success">
          تم إيقاف نشر الموقع. السجل محفوظ.
        </Panel>
      )}

      <Panel className="space-y-3 p-5">
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
          <span
            className={
              detail.site.status === 'published'
                ? 'rounded bg-success/15 px-2 py-0.5 text-xs font-semibold text-success'
                : 'rounded bg-surface px-2 py-0.5 text-xs font-semibold text-muted'
            }
          >
            {detail.site.status === 'published' ? 'منشور' : 'مسودة'}
          </span>
          <span>{detail.snapshot.pages.length} صفحة</span>
          <span>
            {detail.snapshot.pages.reduce((n, p) => n + p.sections.length, 0)} قسم مرئي
          </span>
        </div>
        <p className="text-xs text-muted">
          هذه شاشة عرض وتحكّم بالنشر فقط. تحرير محتوى الصفحات يبقى من حساب العميل — هذا الحساب
          يخصّص المظهر وينشره.
        </p>
      </Panel>

      {preview && (
        <Panel className="overflow-hidden">
          <div className="border-b border-line bg-surface px-4 py-2 text-xs font-semibold text-muted">
            معاينة الصفحة الرئيسية (المسودة الحالية)
          </div>
          <SiteRenderer
            page={preview.page}
            sections={preview.sections}
            theme={detail.settings.theme}
            direction={detail.settings.direction}
            resolved={resolved}
          />
        </Panel>
      )}

      <Panel className="space-y-4 p-5">
        <h2 className="text-sm font-bold text-fg">النشر</h2>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {detail.live ? (
            <>
              <span className="rounded bg-success/15 px-2 py-0.5 text-xs font-semibold text-success">
                منشور
              </span>
              <span className="text-muted">
                النسخة {detail.live.version} — نُشرت{' '}
                <time dateTime={detail.live.publishedAt} className="lb-numeric">
                  {new Date(detail.live.publishedAt).toLocaleDateString('ar-EG')}
                </time>
              </span>
              <UnpublishButton
                unpublishAction={platformUnpublishSiteAction}
                hidden={<input type="hidden" name="code" value={code} />}
                siteId={detail.site.id}
              />
            </>
          ) : (
            <span className="text-muted">لا توجد نسخة منشورة من هذا الموقع.</span>
          )}
        </div>

        <PublishForm
          publishAction={platformPublishSiteAction}
          hidden={<input type="hidden" name="code" value={code} />}
          siteId={detail.site.id}
          hasLive={Boolean(detail.live)}
          pendingChanges={pendingChanges}
        />
      </Panel>

      {revisions.length > 0 && (
        <Panel className="p-5">
          <h2 className="mb-3 text-sm font-bold text-fg">سجل النسخ</h2>
          <ul className="space-y-2">
            {revisions.map((revision) => (
              <li
                key={revision.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-fg">
                    النسخة <span className="lb-numeric">{revision.version}</span>
                    {revision.isLive && (
                      <span className="ms-2 rounded bg-success/15 px-2 py-0.5 text-xs font-semibold text-success">
                        المنشورة الآن
                      </span>
                    )}
                  </p>
                  <p className="truncate text-xs text-muted">
                    <time dateTime={revision.publishedAt} className="lb-numeric">
                      {new Date(revision.publishedAt).toLocaleString('ar-EG')}
                    </time>
                    {revision.note ? ` · ${revision.note}` : ''}
                  </p>
                </div>
                {!revision.isLive && (
                  <RestoreButton
                    rollbackAction={platformRollbackSiteAction}
                    hidden={<input type="hidden" name="code" value={code} />}
                    siteId={detail.site.id}
                    revisionId={revision.id}
                    version={revision.version}
                  />
                )}
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
