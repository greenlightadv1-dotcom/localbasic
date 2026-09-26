import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { FeatureToggle } from './toggle';

export const metadata = { title: 'الخدمات التشغيلية' };
export const dynamic = 'force-dynamic';

/**
 * Scale the workspace up or down. Only meaningful for the restaurant module —
 * a retail-only organization has no kitchen or floor to toggle.
 */
export default async function FeaturesPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'organization.manage')) notFound();
  if (!ctx.enabledModules.includes('restaurant')) notFound();

  const scope = { organizationSlug: ctx.organizationSlug, branchSlug: ctx.branchSlug };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        عطّل ما لا تحتاجه ليبسّط العمل على الكاشير فقط، وفعّله متى احتجته لاحقًا بدون أي إعداد إضافي.
      </p>
      <FeatureToggle
        scope={scope}
        featureKey="kitchen_display_enabled"
        title="شاشة المطبخ"
        description="عرض وتوجيه الطلبات لشاشة المطبخ. عند الإيقاف تختفي شاشة المطبخ ويتابع الكاشير الطلبات مباشرة."
        initialEnabled={ctx.kitchenDisplayEnabled}
      />
      <FeatureToggle
        scope={scope}
        featureKey="captain_hall_enabled"
        title="خدمة الكابتن والصالة"
        description="شاشة الصالة لمتابعة الطاولات والطلبات من الكابتن. عند الإيقاف يعمل الفرع بنظام كاشير فقط."
        initialEnabled={ctx.captainHallEnabled}
      />
    </div>
  );
}
