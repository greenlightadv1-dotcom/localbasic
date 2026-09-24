import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { listBundles } from '@/modules/restaurant/bundles/service';
import { PageHeader } from '@/components/patterns/page-header';
import { BundlesManager } from './bundles-manager';

export const metadata = { title: 'العروض والباقات' };

export default async function BundlesPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'restaurant.menu.read')) notFound();

  const bundles = await listBundles(ctx);

  return (
    <div className="space-y-5">
      <PageHeader
        title="العروض والباقات"
        description="بطاقات عرض على موقعك — اسم، وصف للمحتويات، صورة وسعر واحد شامل. لا ترتبط بنقطة البيع."
      />
      <BundlesManager
        bundles={bundles}
        currency={ctx.currency}
        canManage={can(ctx, 'restaurant.menu.manage')}
        organizationSlug={ctx.organizationSlug}
        branchSlug={ctx.branchSlug}
      />
    </div>
  );
}
