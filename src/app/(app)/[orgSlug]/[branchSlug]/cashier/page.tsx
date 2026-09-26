import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { listMenu } from '@/modules/restaurant/menu/service';
import { listFloor } from '@/modules/restaurant/tables/service';
import { listOrdersWithDetails } from '@/modules/restaurant/orders/service';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { CashierTerminal } from './cashier-terminal';

export const metadata = { title: 'الكاشير' };
export const dynamic = 'force-dynamic';

/** Modifier groups for the till, so a cashier can take a full order. */
async function loadModifiers(organizationId: string, productIds: string[]) {
  if (productIds.length === 0) return [];
  const supabase = createSupabaseServerClient();

  const { data: groups } = await supabase
    .from('restaurant_modifier_groups')
    .select('id, product_id, name, min_select, max_select, sort_order')
    .eq('organization_id', organizationId)
    .eq('is_active', true)
    .in('product_id', productIds)
    .order('sort_order');

  if (!groups?.length) return [];

  const { data: modifiers } = await supabase
    .from('restaurant_modifiers')
    .select('id, group_id, name, price_cents, sort_order')
    .eq('is_active', true)
    .in(
      'group_id',
      groups.map((g) => g.id),
    )
    .order('sort_order');

  return groups.map((g) => ({
    id: g.id,
    productId: g.product_id,
    name: g.name,
    minSelect: g.min_select,
    maxSelect: g.max_select,
    modifiers: (modifiers ?? [])
      .filter((m) => m.group_id === g.id)
      .map((m) => ({ id: m.id, name: m.name, priceCents: m.price_cents })),
  }));
}

export default async function CashierPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'restaurant.pos.use')) notFound();

  const [menu, floor, openOrders] = await Promise.all([
    listMenu(ctx),
    listFloor(ctx),
    listOrdersWithDetails(ctx, { statuses: ['new', 'confirmed', 'preparing', 'ready', 'served'] }),
  ]);

  const modifierGroups = await loadModifiers(
    ctx.organizationId,
    menu.filter((m) => m.modifierGroupCount > 0).map((m) => m.id),
  );

  return (
    <CashierTerminal
      menu={menu.filter((m) => m.isActive)}
      modifierGroups={modifierGroups}
      floor={floor}
      openOrders={openOrders}
      currency={ctx.currency}
      canDiscount={can(ctx, 'restaurant.pos.discount')}
      canCancel={can(ctx, 'restaurant.order.cancel')}
      branchId={ctx.branchId}
      organizationSlug={ctx.organizationSlug}
      branchSlug={ctx.branchSlug}
    />
  );
}
