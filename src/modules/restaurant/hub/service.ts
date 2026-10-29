import 'server-only';
import type { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { staffDbError, toAppError } from '@/lib/errors';
import type { TenantContext } from '@/modules/core/tenancy/context';
import type { AddItemsInput, ModifierGroupInput, copyGroupSchema } from './schemas';

/**
 * The restaurant hub's own reads and writes (0117). Everything else it shows
 * — the floor plan, open orders, kitchen tickets, payments, check splits — is
 * the existing services', so the hub and the dedicated screens never disagree.
 */

async function call<T>(fn: string, args: Record<string, unknown>, context: string): Promise<T> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc(fn as never, args as never);
  if (error) throw staffDbError(error, context);
  return data as T;
}

export async function addOrderItems(ctx: TenantContext, input: AddItemsInput) {
  const rows = await call<{ out_total_cents: number; out_added: number }[]>('restaurant_order_add_items', {
    p_org: ctx.organizationId,
    p_order: input.orderId,
    p_items: input.items.map((i) => ({
      variant_id: i.variantId,
      quantity: i.quantity,
      modifier_ids: i.modifierIds,
      note: i.note ?? null,
    })),
  }, 'addOrderItems');
  const row = rows?.[0];
  return { totalCents: Number(row?.out_total_cents ?? 0), added: Number(row?.out_added ?? 0) };
}

export const saveModifierGroup = (ctx: TenantContext, g: ModifierGroupInput) =>
  call<string>('restaurant_modifier_group_save', {
    p_org: ctx.organizationId,
    p_group: g.groupId ?? null,
    p_product: g.productId ?? null,
    p_name: g.name,
    p_min: g.minSelect,
    p_max: g.maxSelect,
    p_active: g.isActive,
    p_modifiers: g.modifiers.map((m) => ({ id: m.id ?? null, name: m.name, price_cents: m.priceCents, is_active: m.isActive })),
  }, 'saveModifierGroup');

export const copyModifierGroup = (ctx: TenantContext, i: z.infer<typeof copyGroupSchema>) =>
  call<number>('restaurant_modifier_group_copy', {
    p_org: ctx.organizationId, p_group: i.groupId, p_products: i.productIds,
  }, 'copyModifierGroup');

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type HubModifier = { id: string; name: string; priceCents: number; isActive: boolean };
export type HubModifierGroup = {
  id: string;
  productId: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  isActive: boolean;
  modifiers: HubModifier[];
};

/**
 * Modifier groups with their choices. `activeOnly` is the till's view (what a
 * guest can order); the builder reads everything, retired choices included,
 * so one can be brought back.
 */
export async function listModifierGroups(
  ctx: TenantContext,
  options: { activeOnly: boolean; productIds?: string[] },
): Promise<HubModifierGroup[]> {
  if (options.productIds && options.productIds.length === 0) return [];
  const supabase = createSupabaseServerClient();
  let q = supabase
    .from('restaurant_modifier_groups')
    .select('id, product_id, name, min_select, max_select, sort_order, is_active')
    .eq('organization_id', ctx.organizationId)
    .order('sort_order');
  if (options.activeOnly) q = q.eq('is_active', true);
  if (options.productIds) q = q.in('product_id', options.productIds);
  const { data: groups, error } = await q;
  if (error) throw toAppError(error, 'listModifierGroups');
  if (!groups?.length) return [];

  let mq = supabase
    .from('restaurant_modifiers')
    .select('id, group_id, name, price_cents, sort_order, is_active')
    .in('group_id', groups.map((g) => g.id))
    .order('sort_order');
  if (options.activeOnly) mq = mq.eq('is_active', true);
  const { data: modifiers, error: mError } = await mq;
  if (mError) throw toAppError(mError, 'listModifierGroups modifiers');

  const byGroup = new Map<string, HubModifier[]>();
  for (const m of modifiers ?? []) {
    const list = byGroup.get(m.group_id) ?? [];
    list.push({ id: m.id, name: m.name, priceCents: Number(m.price_cents), isActive: m.is_active });
    byGroup.set(m.group_id, list);
  }
  return groups.map((g) => ({
    id: g.id,
    productId: g.product_id,
    name: g.name,
    minSelect: g.min_select,
    maxSelect: g.max_select,
    isActive: g.is_active,
    modifiers: byGroup.get(g.id) ?? [],
  }));
}
