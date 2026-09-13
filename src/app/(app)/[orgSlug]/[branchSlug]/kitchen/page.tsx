import { notFound } from 'next/navigation';
import { resolveTenantContext } from '@/modules/core/tenancy/context';
import { listOrders } from '@/modules/restaurant/orders/service';
import { getOrder } from '@/modules/restaurant/orders/service';
import { KitchenBoard } from './kitchen-board';

export const metadata = { title: 'شاشة المطبخ' };
// The kitchen board must reflect the floor, not a cached copy of it.
export const dynamic = 'force-dynamic';

export default async function KitchenPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!ctx.permissions.has('restaurant.kitchen.use')) notFound();

  const orders = await listOrders(ctx, { statuses: ['confirmed', 'preparing', 'ready'] });
  const tickets = await Promise.all(
    orders.map(async (summary) => {
      const { lines } = await getOrder(ctx, summary.id);
      return { summary, lines };
    }),
  );

  return (
    <KitchenBoard
      tickets={tickets}
      organizationSlug={ctx.organizationSlug}
      branchSlug={ctx.branchSlug}
    />
  );
}
