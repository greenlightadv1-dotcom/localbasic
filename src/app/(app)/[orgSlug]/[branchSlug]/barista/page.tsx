import { notFound } from 'next/navigation';
import { resolveTenantContext } from '@/modules/core/tenancy/context';
import { listKitchenTickets } from '@/modules/restaurant/orders/service';
import { listStations } from '@/modules/restaurant/stations/service';
import { KitchenBoard } from '../kitchen/kitchen-board';

export const metadata = { title: 'شاشة الباريستا' };
// The board must reflect the floor, not a cached copy of it.
export const dynamic = 'force-dynamic';

/**
 * The barista's screen — bar-station tickets only (0080). Shares the same
 * KitchenBoard component /kitchen renders, since the two boards are
 * identical apart from which station's tickets they hold: same columns, same
 * per-line reassignment control, same no-financial-information guarantee
 * from listKitchenTickets(). Gated on restaurant.bar.use, a permission
 * restaurant.kitchen.use does not carry — a chef cannot open this screen and
 * a barista cannot open /kitchen, by role, not by a filter either could
 * switch off.
 */
export default async function BaristaPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!ctx.permissions.has('restaurant.bar.use')) notFound();
  if (!ctx.kitchenDisplayEnabled) notFound();

  const [tickets, stations] = await Promise.all([
    listKitchenTickets(ctx, undefined, 'bar'),
    listStations(ctx),
  ]);

  return (
    <KitchenBoard
      stationKind="bar"
      tickets={tickets}
      stations={stations}
      canReassign={ctx.permissions.has('restaurant.menu.manage')}
      organizationSlug={ctx.organizationSlug}
      branchSlug={ctx.branchSlug}
    />
  );
}
