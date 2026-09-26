import { notFound } from 'next/navigation';
import { resolveTenantContext } from '@/modules/core/tenancy/context';
import { listKitchenTickets } from '@/modules/restaurant/orders/service';
import { listStations } from '@/modules/restaurant/stations/service';
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
  if (!ctx.kitchenDisplayEnabled) notFound();

  // One batched call: four queries whatever the board holds, and no price
  // column selected, so nothing financial reaches the client payload.
  const [tickets, stations] = await Promise.all([listKitchenTickets(ctx), listStations(ctx)]);

  return (
    <KitchenBoard
      tickets={tickets}
      stations={stations}
      canReassign={ctx.permissions.has('restaurant.menu.manage')}
      organizationSlug={ctx.organizationSlug}
      branchSlug={ctx.branchSlug}
    />
  );
}
