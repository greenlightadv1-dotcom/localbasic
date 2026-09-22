import Link from 'next/link';
import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { PageHeader } from '@/components/patterns/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { getSiteDetail } from '@/modules/sites/service';
import { listMenuCategories } from '@/modules/sites/resolve';
import { selectPage } from '@/modules/sites/pages';
import {
  SECTION_DESCRIPTIONS,
  SECTION_LABELS,
  isDataBoundSection,
} from '@/modules/sites/schemas';
import {
  AddSection,
  DeleteSectionButton,
  MoveSectionButtons,
  SectionForm,
  VisibilityToggle,
} from './forms';

export const metadata = { title: 'تحرير الصفحة' };
export const dynamic = 'force-dynamic';

/**
 * The section editor for one page.
 *
 * Read-scoped by `site.read` through getSiteDetail; every WRITE on the screen
 * posts to a Server Action that re-checks `site.manage`. A viewer therefore
 * sees the page and is offered no controls — and would be refused server-side
 * even if they forged one.
 *
 * The page is resolved with selectPage(), the same helper the preview uses, so
 * a page id from another site is absent from the authorized result and answers
 * not-found rather than being fetched and checked afterwards.
 */
export default async function SitePageEditor({
  params,
  searchParams,
}: {
  params: { orgSlug: string; branchSlug: string; siteId: string; pageId: string };
  searchParams: { saved?: string; added?: string; deleted?: string; error?: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  const detail = await getSiteDetail(ctx, params.siteId);
  if (!detail) notFound();

  const selected = selectPage(detail, { kind: 'id', pageId: params.pageId });
  if (!selected.ok) notFound();

  const { site } = detail;
  const { page, sections } = selected;
  const manage = can(ctx, 'site.manage');
  const base = `/${ctx.organizationSlug}/${ctx.branchSlug}/settings/sites`;
  const ids = {
    orgSlug: ctx.organizationSlug,
    branchSlug: ctx.branchSlug,
    siteId: site.id,
    pageId: page.id,
  };

  // Only for the menu section's category picker. Names and ids, nothing that
  // could be stored: the section saves the ids it was narrowed to and never
  // the categories themselves.
  const categories = sections.some((s) => s.sectionType === 'menu')
    ? await listMenuCategories(ctx)
    : [];

  return (
    <div className="space-y-5">
      <PageHeader
        title={page.title}
        description={`${site.name} · /${page.slug}`}
        actions={
          <>
            <Link href={`${base}/${site.id}/preview?page=${encodeURIComponent(page.id)}`}>
              <Button variant="outline" size="sm">
                معاينة هذه الصفحة
              </Button>
            </Link>
            <Link href={`${base}/${site.id}`}>
              <Button variant="ghost" size="sm">
                كل الصفحات
              </Button>
            </Link>
          </>
        }
      />

      {searchParams.error && <Alert tone="danger">{searchParams.error}</Alert>}
      {searchParams.saved && <Alert tone="success">تم حفظ القسم.</Alert>}
      {searchParams.added && <Alert tone="success">تمت إضافة القسم. حرّره بالأسفل.</Alert>}
      {searchParams.deleted && <Alert tone="success">تم حذف القسم.</Alert>}

      {!manage && (
        <Alert tone="info">
          لديك صلاحية العرض فقط. التحرير يتطلّب صلاحية إدارة المواقع.
        </Alert>
      )}

      {page.isHomepage && <Badge tone="info">الصفحة الرئيسية</Badge>}

      {manage && (
        <Card>
          <CardHeader>
            <CardTitle>إضافة قسم</CardTitle>
          </CardHeader>
          <CardBody>
            <AddSection ids={ids} />
          </CardBody>
        </Card>
      )}

      {sections.length === 0 ? (
        <Card>
          <CardBody>
            <p className="text-sm text-muted">
              لا توجد أقسام في هذه الصفحة بعد. الصفحة الفارغة صالحة تمامًا — أضف
              قسمًا عندما تكون جاهزًا.
            </p>
          </CardBody>
        </Card>
      ) : (
        sections.map((section, index) => (
          <Card key={section.id}>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <CardTitle>
                    {SECTION_LABELS[section.sectionType]}
                    {/* Not colour alone: the live sections say so in words. */}
                    {isDataBoundSection(section.sectionType) && (
                      <Badge tone="info" className="ms-2">
                        بيانات حيّة
                      </Badge>
                    )}
                    {!section.isVisible && (
                      <Badge tone="warn" className="ms-2">
                        مخفي
                      </Badge>
                    )}
                  </CardTitle>
                  <p className="mt-1 text-xs text-muted">
                    {SECTION_DESCRIPTIONS[section.sectionType]}
                  </p>
                </div>

                {manage && (
                  <div className="flex flex-wrap items-center gap-1">
                    <MoveSectionButtons
                      ids={ids}
                      sectionId={section.id}
                      label={SECTION_LABELS[section.sectionType]}
                      isFirst={index === 0}
                      isLast={index === sections.length - 1}
                    />
                    <VisibilityToggle ids={ids} section={section} />
                    <DeleteSectionButton
                      ids={ids}
                      sectionId={section.id}
                      label={SECTION_LABELS[section.sectionType]}
                    />
                  </div>
                )}
              </div>
            </CardHeader>
            {manage && (
              <CardBody>
                <SectionForm ids={ids} section={section} categories={categories} />
              </CardBody>
            )}
          </Card>
        ))
      )}
    </div>
  );
}
