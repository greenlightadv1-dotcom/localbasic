import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getOrganizationByCode } from '@/modules/platform/billing/service';
import { platformGetSiteDetail } from '@/modules/platform/sites/service';
import { resolveSectionData } from '@/modules/sites/resolve';
import { SiteRenderer } from '@/modules/sites/renderer';
import type { SitePage, SiteSection } from '@/modules/sites/types';
import type { SnapshotPage } from '@/modules/sites/publishing';
import { AppearanceForm } from '@/app/(app)/[orgSlug]/[branchSlug]/settings/sites/[siteId]/forms';
import { AdminHeading, Panel, CustomerCode } from '../../../../../ui';
import { platformUpdateThemeAction } from '../actions';

export async function generateMetadata({ params }: { params: { code: string } }) {
  return { title: 'مخصّص المظهر', robots: { index: false, follow: false } };
}

export const dynamic = 'force-dynamic';

function pageAndSections(page: SnapshotPage, siteId: string): { page: SitePage; sections: SiteSection[] } {
  return {
    page: {
      id: page.id, siteId, title: page.title, slug: page.slug,
      isHomepage: page.isHomepage, sortOrder: page.sortOrder,
    },
    sections: page.sections.map((s) => ({
      id: s.id, pageId: page.id, sectionType: s.sectionType,
      content: s.content, sortOrder: s.sortOrder, isVisible: true,
    })),
  };
}

/**
 * The Theme Customizer.
 *
 * ONE screen: the SAME AppearanceForm the tenant site detail page renders,
 * given Platform Admin's own action, and a preview of the site with the
 * theme currently saved to site_settings — refreshed the moment the form
 * redirects back here after a save, the same save-then-see-it pattern the
 * tenant flow already uses (save appearance, then open /preview). Nothing
 * here decides colours live in the browser ahead of a save: what this screen
 * shows is always what site_settings actually holds, in draft, not yet
 * published.
 */
export default async function ThemeCustomizerPage({
  params,
  searchParams,
}: {
  params: { code: string; siteId: string };
  searchParams: { saved?: string };
}) {
  const code = decodeURIComponent(params.code);
  const org = await getOrganizationByCode(code);
  if (!org) notFound();

  const detail = await platformGetSiteDetail(code, params.siteId);
  if (!detail) notFound();

  const home = detail.snapshot.pages.find((p) => p.isHomepage) ?? detail.snapshot.pages[0];
  const preview = home ? pageAndSections(home, detail.site.id) : null;
  const resolved = preview
    ? await resolveSectionData(
        {
          organizationId: detail.organization.id,
          organizationName: detail.organization.name,
          currency: detail.organization.currency,
        },
        preview.sections,
      )
    : undefined;

  const base = `/admin/customers/${encodeURIComponent(code)}/sites/${detail.site.id}`;

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-4 py-8">
      <AdminHeading title="مخصّص المظهر" lead={`${detail.site.name} · ${org.name}`} />

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <CustomerCode code={org.customerCode} />
        <Link href={base} className="text-primary hover:underline">
          رجوع لصفحة الموقع
        </Link>
        <span
          className={
            detail.site.status === 'published'
              ? 'ms-auto rounded bg-success/15 px-2 py-0.5 text-xs font-semibold text-success'
              : 'ms-auto rounded bg-surface px-2 py-0.5 text-xs font-semibold text-muted'
          }
        >
          {detail.site.status === 'published' ? 'منشور' : 'مسودة'}
        </span>
      </div>

      {searchParams.saved && (
        <Panel className="border-success/40 bg-success/5 px-4 py-3 text-sm text-success">
          تم حفظ المظهر كمسودة. لن يظهر للزوار إلا بعد نشر الموقع من صفحة الموقع.
        </Panel>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,360px)_1fr]">
        <Panel className="space-y-4 p-5">
          <h2 className="text-sm font-bold text-fg">الألوان والاتجاه</h2>
          <AppearanceForm
            appearanceAction={platformUpdateThemeAction}
            hidden={<input type="hidden" name="code" value={code} />}
            siteId={detail.site.id}
            config={{
              direction: detail.settings.direction,
              locale: detail.settings.locale,
              theme: detail.settings.theme,
            }}
          />
        </Panel>

        <Panel className="overflow-hidden">
          <div className="border-b border-line bg-surface px-4 py-2 text-xs font-semibold text-muted">
            معاينة الصفحة الرئيسية بالمظهر المحفوظ حاليًا
          </div>
          {preview ? (
            <SiteRenderer
              page={preview.page}
              sections={preview.sections}
              theme={detail.settings.theme}
              direction={detail.settings.direction}
              resolved={resolved}
            />
          ) : (
            <p className="px-6 py-16 text-center text-sm text-muted">
              لا توجد صفحات في هذا الموقع بعد.
            </p>
          )}
        </Panel>
      </div>
    </div>
  );
}
