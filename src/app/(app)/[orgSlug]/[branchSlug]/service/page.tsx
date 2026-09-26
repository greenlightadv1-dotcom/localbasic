import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { listOrders } from '@/modules/restaurant/orders/service';
import { listFloor } from '@/modules/restaurant/tables/service';
import { PageHeader } from '@/components/patterns/page-header';
import { ServiceBoard } from './service-board';

export const metadata = { title: 'الصالة' };
export const dynamic = 'force-dynamic';

export default async function ServicePage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'restaurant.service.use')) notFound();
  if (!ctx.captainHallEnabled) notFound();

  const [orders, floor] = await Promise.all([
    listOrders(ctx, { statuses: ['new', 'confirmed', 'preparing', 'ready', 'served'] }),
    listFloor(ctx),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader title="الصالة" description={`${ctx.branchName} — الطاولات والطلبات الجاهزة`} />
      <ServiceBoard
        orders={orders}
        floor={floor}
        currency={ctx.currency}
        canSetTableStatus={can(ctx, 'restaurant.table.status')}
        organizationSlug={ctx.organizationSlug}
        branchSlug={ctx.branchSlug}
      />
    </div>
  );
}
