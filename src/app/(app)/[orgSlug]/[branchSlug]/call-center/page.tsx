import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { listMenu } from '@/modules/restaurant/menu/service';
import { listZones } from '@/modules/restaurant/delivery/service';
import { DataUnavailable } from '@/components/patterns/data-unavailable';
import { PageHeader } from '@/components/patterns/page-header';
import { CallCenter } from './call-center';

export const metadata = { title: 'الكول سنتر' };
export const dynamic = 'force-dynamic';

export default async function CallCenterPage({ params }: { params: { orgSlug: string; branchSlug: string } }) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'restaurant.callcenter.use')) notFound();
  if (!ctx.enabledModules.includes('restaurant')) notFound();

  let menu; let zones;
  try {
    [menu, zones] = await Promise.all([listMenu(ctx), listZones(ctx)]);
  } catch (error) {
    return <DataUnavailable error={error} />;
  }

  const items = menu.filter((m) => m.isActive).flatMap((m) => m.variants.filter((v) => v.isAvailableHere).map((v) => ({
    variantId: v.id, productName: m.name, variantName: v.name, categoryName: m.categoryName, priceCents: v.priceCents,
  })));

  return (
    <div className="space-y-4">
      <PageHeader title="الكول سنتر" description="ابحث برقم المتصل، اختر العنوان، كرّر طلبًا سابقًا أو أنشئ طلبًا جديدًا يذهب مباشرة للمطبخ." />
      <CallCenter
        scope={{ organizationSlug: ctx.organizationSlug, branchSlug: ctx.branchSlug }}
        currency={ctx.currency}
        items={items}
        zones={zones.filter((z) => z.isActive)}
      />
    </div>
  );
}
