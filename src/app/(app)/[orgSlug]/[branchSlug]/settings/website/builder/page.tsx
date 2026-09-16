import Link from 'next/link';
import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import {
  listSections, getTheme, getPublishState,
} from '@/modules/restaurant/website/builder';
import {
  SECTION_TYPES, SECTION_LABELS, SECTION_HINTS, SINGLETON_SECTIONS,
  type SectionType,
} from '@/modules/restaurant/website/builder-shared';
import { getWebsiteSettings } from '@/modules/restaurant/website/settings';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { AddSection, MoveButtons, PublishForm, RemoveSection, SectionForm, ThemeForm } from './forms';

export const metadata = { title: 'محرّر الموقع' };
export const dynamic = 'force-dynamic';

/**
 * The website builder.
 *
 * Everything on this page edits the DRAFT. Nothing a visitor sees changes
 * until Publish, which snapshots the draft into a revision inside the
 * database — see migration 0042.
 */
export default async function BuilderPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; branchSlug: string };
  searchParams: { saved?: string; published?: string; unpublished?: string; error?: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'settings.manage')) notFound();
  if (!ctx.enabledModules.includes('restaurant')) notFound();

  const [sections, theme, publishState, settings] = await Promise.all([
    listSections(ctx),
    getTheme(ctx),
    getPublishState(ctx),
    getWebsiteSettings(ctx),
  ]);

  const used = new Set(sections.map((s) => s.type));
  const available = SECTION_TYPES.filter(
    (t) => !(SINGLETON_SECTIONS as SectionType[]).includes(t) || !used.has(t),
  );

  const base = `/${params.orgSlug}/${params.branchSlug}/settings/website`;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-wrap items-center gap-2">
          <CardTitle>محرّر الموقع</CardTitle>
          {publishState.liveVersion ? (
            <Badge tone="success">منشور — إصدار {publishState.liveVersion}</Badge>
          ) : (
            <Badge tone="warn">لم يُنشر تصميم مخصّص</Badge>
          )}
          {publishState.hasDraftChanges ? <Badge tone="info">توجد تعديلات غير منشورة</Badge> : null}
          <div className="ms-auto flex gap-2">
            <Link
              href={`${base}/builder/preview`}
              className="inline-flex h-9 items-center rounded border border-line bg-elevated px-3 text-sm font-semibold text-fg hover:bg-surface"
            >
              معاينة المسودة
            </Link>
            <Link
              href={base}
              className="inline-flex h-9 items-center rounded px-3 text-sm font-semibold text-muted hover:text-fg"
            >
              إعدادات الموقع
            </Link>
          </div>
        </CardHeader>
        <CardBody className="space-y-3">
          {searchParams.saved ? (
            <Alert tone="success">تم الحفظ في المسودة. اضغط «نشر» ليراها الزوار.</Alert>
          ) : null}
          {searchParams.published ? (
            // The test id sits on the child: Alert takes a fixed prop set and
            // does not forward arbitrary attributes.
            <Alert tone="success">
              <span data-testid="published-ok">
                تم نشر الإصدار {searchParams.published}.
              </span>
            </Alert>
          ) : null}
          {searchParams.unpublished ? (
            <Alert tone="warn">تم إيقاف النشر. يعرض الموقع الآن التصميم الافتراضي.</Alert>
          ) : null}
          {searchParams.error ? <Alert tone="danger">{searchParams.error}</Alert> : null}

          {!settings.enabled ? (
            <Alert tone="warn">
              الموقع غير منشور من إعدادات الموقع، فلن يظهر لأي زائر مهما نشرت هنا.
            </Alert>
          ) : null}

          <p className="text-sm text-muted">
            التعديلات هنا مسودة. الزوار يرون آخر إصدار منشور فقط.
          </p>
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>الأقسام</CardTitle>
            </CardHeader>
            <CardBody className="space-y-4">
              <AddSection
                orgSlug={params.orgSlug}
                branchSlug={params.branchSlug}
                available={available}
              />

              {sections.length === 0 ? (
                <p className="rounded border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
                  لا توجد أقسام بعد. سيعرض موقعك التصميم الافتراضي حتى تضيف أقسامًا وتنشرها.
                </p>
              ) : (
                <ul className="space-y-3">
                  {sections.map((section, i) => (
                    <li key={section.id} className="rounded-lg border border-line bg-surface">
                      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
                        <span className="font-bold text-fg">{SECTION_LABELS[section.type]}</span>
                        {!section.enabled ? <Badge tone="warn">مخفي</Badge> : null}
                        <span className="ms-auto flex items-center gap-1">
                          <MoveButtons
                            orgSlug={params.orgSlug}
                            branchSlug={params.branchSlug}
                            id={section.id}
                            isFirst={i === 0}
                            isLast={i === sections.length - 1}
                          />
                          <RemoveSection
                            orgSlug={params.orgSlug}
                            branchSlug={params.branchSlug}
                            id={section.id}
                          />
                        </span>
                      </div>
                      <div className="px-4 py-3">
                        <p className="mb-3 text-xs text-muted">{SECTION_HINTS[section.type]}</p>
                        <SectionForm
                          orgSlug={params.orgSlug}
                          branchSlug={params.branchSlug}
                          section={section}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>النشر</CardTitle>
            </CardHeader>
            <CardBody>
              <PublishForm
                orgSlug={params.orgSlug}
                branchSlug={params.branchSlug}
                liveVersion={publishState.liveVersion}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>المظهر</CardTitle>
            </CardHeader>
            <CardBody>
              <ThemeForm
                orgSlug={params.orgSlug}
                branchSlug={params.branchSlug}
                theme={theme}
              />
            </CardBody>
          </Card>

          <Card>
            <CardBody className="space-y-2 text-xs leading-relaxed text-muted">
              <p className="font-semibold text-fg">ما لا يسمح به المحرّر</p>
              <p>
                لا يمكن إدخال HTML أو CSS أو JavaScript. النصوص نصوص فقط، والصور روابط
                https، والألوان والخطوط من قائمة محدّدة. هذا مقصود: أمان الموقع أهم من
                المرونة.
              </p>
              <p>
                أسعار المنيو وتوافر الأصناف تأتي من نظام المنيو، ولا يغيّرها المحرّر.
              </p>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
