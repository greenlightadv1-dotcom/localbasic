import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChefHat, LayoutGrid, SlidersHorizontal } from 'lucide-react';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { getFloorPlan } from '@/modules/restaurant/floor/service';
import { listMenu } from '@/modules/restaurant/menu/service';
import { listKitchenTickets, listOrdersWithDetails } from '@/modules/restaurant/orders/service';
import { listStations } from '@/modules/restaurant/stations/service';
import { listModifierGroups } from '@/modules/restaurant/hub/service';
import { HUB_TABS, type HubTab } from '@/modules/restaurant/hub/schemas';
import { DataUnavailable } from '@/components/patterns/data-unavailable';
import { PageHeader } from '@/components/patterns/page-header';
import { cn } from '@/lib/cn';
import { PosFloor } from './pos-floor';
import { KdsBoard } from './kds-board';
import { ModifierBuilder } from './modifier-builder';

export const metadata = { title: 'المطعم والمطبخ' };
// Live service: never a cached copy of the floor or the pass.
export const dynamic = 'force-dynamic';

const TAB_META: Record<HubTab, { label: string; icon: typeof LayoutGrid }> = {
  tables: { label: 'الطاولات ونقطة البيع', icon: LayoutGrid },
  kds: { label: 'شاشة المطبخ', icon: ChefHat },
  modifiers: { label: 'الإضافات والتعديلات', icon: SlidersHorizontal },
};

/**
 * The restaurant hub: the floor and its till, the kitchen display and the
 * modifier builder on one screen, each tab shown only to the roles that can
 * use it. It reads and writes through the same services as /floor, /cashier,
 * /kitchen and /menu — it is another view of the same service, not a second
 * system — and loads only the active tab's data.
 */
export default async function RestaurantHubPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; branchSlug: string };
  searchParams: { tab?: string; station?: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!ctx.enabledModules.includes('restaurant')) notFound();

  const canKitchen = can(ctx, 'restaurant.kitchen.use');
  const canBar = can(ctx, 'restaurant.bar.use');
  const allowed: Record<HubTab, boolean> = {
    tables: can(ctx, 'restaurant.table.read'),
    kds: (canKitchen || canBar) && ctx.kitchenDisplayEnabled,
    modifiers: can(ctx, 'restaurant.menu.manage'),
  };
  const tabs = HUB_TABS.filter((t) => allowed[t]);
  if (tabs.length === 0) notFound();
  const tab: HubTab = tabs.includes(searchParams.tab as HubTab) ? (searchParams.tab as HubTab) : tabs[0]!;
  const base = `/${ctx.organizationSlug}/${ctx.branchSlug}`;
  const scope = { organizationSlug: ctx.organizationSlug, branchSlug: ctx.branchSlug };

  let body: React.ReactNode;
  try {
    if (tab === 'tables') {
      const [plan, open, menu] = await Promise.all([
        getFloorPlan(ctx),
        listOrdersWithDetails(ctx, { statuses: ['new', 'confirmed', 'preparing', 'ready', 'served'] }),
        listMenu(ctx),
      ]);
      const active = menu.filter((m) => m.isActive);
      const groups = await listModifierGroups(ctx, {
        activeOnly: true,
        productIds: active.filter((m) => m.modifierGroupCount > 0).map((m) => m.id),
      });
      body = (
        <PosFloor
          scope={scope}
          basePath={base}
          branchId={ctx.branchId}
          currency={ctx.currency}
          plan={plan}
          openOrders={open}
          menu={active}
          modifierGroups={groups}
          can={{
            order: can(ctx, 'restaurant.order.create'),
            pay: can(ctx, 'restaurant.pos.use'),
            discount: can(ctx, 'restaurant.pos.discount'),
            split: can(ctx, 'restaurant.table.transfer'),
            setStatus: can(ctx, 'restaurant.table.status'),
            serve: can(ctx, 'restaurant.service.use'),
            delivery: can(ctx, 'restaurant.callcenter.use'),
          }}
        />
      );
    } else if (tab === 'kds') {
      const kind: 'kitchen' | 'bar' =
        searchParams.station === 'bar' && canBar ? 'bar' : canKitchen ? 'kitchen' : 'bar';
      const [tickets, stations] = await Promise.all([
        listKitchenTickets(ctx, ['confirmed', 'preparing', 'ready', 'served'], kind),
        listStations(ctx),
      ]);
      body = (
        <KdsBoard
          scope={scope}
          basePath={base}
          organizationId={ctx.organizationId}
          branchId={ctx.branchId}
          stationKind={kind}
          kinds={[...(canKitchen ? (['kitchen'] as const) : []), ...(canBar ? (['bar'] as const) : [])]}
          tickets={tickets}
          stations={stations}
          canServe={can(ctx, 'restaurant.service.use')}
        />
      );
    } else {
      const [menu, groups] = await Promise.all([listMenu(ctx), listModifierGroups(ctx, { activeOnly: false })]);
      body = (
        <ModifierBuilder
          scope={scope}
          currency={ctx.currency}
          products={menu.map((m) => ({
            id: m.id, name: m.name, categoryName: m.categoryName, isActive: m.isActive,
            basePriceCents: m.variants[0]?.priceCents ?? 0,
          }))}
          groups={groups}
        />
      );
    }
  } catch (error) {
    body = <DataUnavailable error={error} />;
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="المطعم والمطبخ"
        description="الطاولات والطلبات والتحصيل، وشاشة المطبخ اللحظية، وبناء الإضافات على الأصناف — في مكان واحد."
      />
      {tabs.length > 1 && (
        <nav aria-label="أقسام المطعم" className="flex gap-1 overflow-x-auto border-b border-line">
          {tabs.map((t) => {
            const Icon = TAB_META[t].icon;
            return (
              <Link key={t} href={`${base}/restaurant?tab=${t}`} aria-current={t === tab ? 'page' : undefined}
                className={cn('-mb-px inline-flex shrink-0 items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-semibold',
                  t === tab ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-fg')}
                data-testid={`hub-tab-${t}`}>
                <Icon className="h-4 w-4" aria-hidden="true" /> {TAB_META[t].label}
              </Link>
            );
          })}
        </nav>
      )}
      {body}
    </div>
  );
}
