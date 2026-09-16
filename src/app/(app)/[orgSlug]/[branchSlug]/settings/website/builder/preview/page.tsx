import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { listSections, getTheme } from '@/modules/restaurant/website/builder';
import { RestaurantSite } from '@/app/(public)/r/[orgSlug]/page-shell';

export const dynamic = 'force-dynamic';

// A draft is not public and must never be indexed.
export const metadata: Metadata = {
  title: 'معاينة المسودة',
  robots: { index: false, follow: false },
};

/**
 * Draft preview.
 *
 * Deliberately NOT a public route with a token. It lives under the tenant
 * workspace and is gated by the same membership and permission check as the
 * builder itself, so there is no preview URL to leak, guess or forget to
 * revoke — the only way to see a draft is to be someone who may edit it.
 *
 * It renders through the same component the public site uses, so what an
 * owner previews is what visitors will get, rather than a second renderer
 * that could drift.
 */
export default async function BuilderPreviewPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'settings.manage')) notFound();
  if (!ctx.enabledModules.includes('restaurant')) notFound();

  const [sections, theme] = await Promise.all([listSections(ctx), getTheme(ctx)]);

  // Disabled sections are excluded here exactly as publishing excludes them,
  // so the preview cannot flatter the draft.
  const draft = {
    sections: sections
      .filter((s) => s.enabled)
      .map((s) => ({ type: s.type, config: s.config })),
    theme,
  };

  return (
    <div className="-m-4 sm:-m-6">
      <div className="sticky top-0 z-50 flex flex-wrap items-center gap-3 bg-warn px-4 py-2 text-sm font-semibold text-white">
        <span>معاينة المسودة — لا يراها الزوار</span>
        <Link
          href={`/${params.orgSlug}/${params.branchSlug}/settings/website/builder`}
          className="ms-auto rounded bg-white/20 px-3 py-1 hover:bg-white/30"
        >
          رجوع للمحرّر
        </Link>
      </div>
      {draft.sections.length === 0 ? (
        <p className="p-10 text-center text-sm text-muted">
          لا توجد أقسام مفعّلة في المسودة، فلا شيء لمعاينته.
        </p>
      ) : (
        <RestaurantSite orgSlug={params.orgSlug} draft={draft} />
      )}
    </div>
  );
}
