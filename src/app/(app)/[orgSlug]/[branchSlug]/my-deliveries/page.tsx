import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { getDispatchBoard, getMyDriver } from '@/modules/restaurant/delivery/service';
import { DataUnavailable } from '@/components/patterns/data-unavailable';
import { EmptyState } from '@/components/patterns/states';
import { PageHeader } from '@/components/patterns/page-header';
import { MyDeliveries } from './my-deliveries';

export const metadata = { title: 'رحلاتي' };
export const dynamic = 'force-dynamic';

/** The driver's phone screen: only their own trips (RLS: app.is_my_driver). */
export default async function MyDeliveriesPage({ params }: { params: { orgSlug: string; branchSlug: string } }) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'restaurant.driver.use')) notFound();

  let driver; let orders;
  try {
    driver = await getMyDriver(ctx);
    orders = driver ? await getDispatchBoard(ctx, { driverId: driver.id }) : [];
  } catch (error) {
    return <DataUnavailable error={error} />;
  }
  if (!driver) {
    return <EmptyState title="حسابك غير مربوط بمندوب" description="اطلب من المدير ربط حسابك ببيانات المندوب في شاشة التوصيل." />;
  }

  return (
    <div className="space-y-4">
      <PageHeader title={`رحلاتي — ${driver.name}`} description="الطلبات المعيّنة لك، وعهدتك وعمولتك الحالية." />
      <MyDeliveries
        scope={{ organizationSlug: ctx.organizationSlug, branchSlug: ctx.branchSlug }}
        branchId={ctx.branchId} currency={ctx.currency} driver={driver} orders={orders}
      />
    </div>
  );
}
