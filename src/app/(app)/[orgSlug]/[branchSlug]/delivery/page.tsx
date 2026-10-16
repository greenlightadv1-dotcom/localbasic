import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { getDispatchBoard, listDriverMembers, listDrivers, listZones } from '@/modules/restaurant/delivery/service';
import { DataUnavailable } from '@/components/patterns/data-unavailable';
import { PageHeader } from '@/components/patterns/page-header';
import { DispatchView } from './dispatch-view';

export const metadata = { title: 'التوصيل والمناديب' };
export const dynamic = 'force-dynamic';

export default async function DeliveryPage({ params }: { params: { orgSlug: string; branchSlug: string } }) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!ctx.enabledModules.includes('restaurant')) notFound();
  const canDispatch = can(ctx, 'restaurant.delivery.manage');
  const canManage = can(ctx, 'restaurant.driver.manage');
  const canSettle = can(ctx, 'restaurant.driver.settle');
  if (!canDispatch && !canManage && !canSettle) notFound();

  let data;
  try {
    const [orders, drivers, zones, members] = await Promise.all([
      getDispatchBoard(ctx), listDrivers(ctx), listZones(ctx), canManage ? listDriverMembers(ctx) : Promise.resolve([]),
    ]);
    data = { orders, drivers, zones, members };
  } catch (error) {
    return <DataUnavailable error={error} />;
  }

  return (
    <div className="space-y-4">
      <PageHeader title="التوصيل والمناديب" description="توزيع الطلبات على المناديب، متابعة الرحلة، عهدة النقدية والعمولات." />
      <DispatchView
        scope={{ organizationSlug: ctx.organizationSlug, branchSlug: ctx.branchSlug }}
        branchId={ctx.branchId}
        currency={ctx.currency}
        {...data}
        can={{ dispatch: canDispatch, manage: canManage, settle: canSettle }}
      />
    </div>
  );
}
