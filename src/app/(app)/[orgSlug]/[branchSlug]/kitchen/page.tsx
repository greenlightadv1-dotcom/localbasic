import { notFound } from 'next/navigation';
import { resolveTenantContext } from '@/modules/core/tenancy/context';
import { listKitchenTickets } from '@/modules/restaurant/orders/service';
import { listStations } from '@/modules/restaurant/stations/service';
import { KitchenBoard } from './kitchen-board';

export const metadata = { title: 'شاشة المطبخ (الشيف)' };
// The kitchen board must reflect the floor, not a cached copy of it.
export const dynamic = 'force-dynamic';

/**
 * The chef's screen — kitchen-station tickets only (0080). The barista's
 * equivalent lives at /barista, sharing this same KitchenBoard component with
 * its own permission and its own server-side station filter, never this
 * route: a chef and a barista are separate roles with separate screens, not
 * one shared board with a client-side tab.
 */
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
  const [tickets, stations] = await Promise.all([
    listKitchenTickets(ctx, undefined, 'kitchen'),
    listStations(ctx),
  ]);

  return (
    <KitchenBoard
      stationKind="kitchen"
      tickets={tickets}
      stations={stations}
      canReassign={ctx.permissions.has('restaurant.menu.manage')}
      organizationSlug={ctx.organizationSlug}
      branchSlug={ctx.branchSlug}
    />
  );
}
