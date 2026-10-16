import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { toDataUnavailable } from '@/lib/errors';
import type { TenantContext } from '@/modules/core/tenancy/context';
import type { LocationKind } from '@/modules/restaurant/inventory/service';
import type { BaseUnit } from '@/modules/restaurant/inventory/units';
import { summarizeWastage, type WastageSummary } from './summary';

export type { WastageSummary } from './summary';

/**
 * Kitchen losses (0109 restaurant_wastage_logs over 0102 inventory_waste).
 * Logging goes through inventory_record_waste (stock leaves the location it
 * was in, costed at the average cost); this reads the log and its totals.
 */

export type WastageEntry = {
  id: string; itemId: string; itemName: string; unit: BaseUnit; location: LocationKind; qty: number; costCents: number;
  reason: string; note: string | null; orderId: string | null; movedStock: boolean; recordedBy: string | null; createdAt: string;
};

export async function getWastage(ctx: TenantContext, from: Date, to: Date): Promise<{ entries: WastageEntry[]; summary: WastageSummary }> {
  const supabase = createSupabaseServerClient();
  const [logs, items] = await Promise.all([
    supabase.from('restaurant_wastage_logs')
      .select('id, inventory_item_id, unit, location_kind, quantity, cost_cents, reason, note, order_id, moved_stock, recorded_by, created_at')
      .eq('branch_id', ctx.branchId).gte('created_at', from.toISOString()).lt('created_at', to.toISOString())
      .order('created_at', { ascending: false }).limit(1000),
    supabase.from('inventory_items').select('id, name').eq('organization_id', ctx.organizationId),
  ]);
  if (logs.error) throw toDataUnavailable(logs.error, 'getWastage');
  const names = new Map((items.data ?? []).map((i) => [i.id, i.name]));
  const userIds = [...new Set((logs.data ?? []).map((l) => l.recorded_by).filter(Boolean))] as string[];
  const { data: people } = userIds.length
    ? await supabase.from('profiles').select('id, full_name').in('id', userIds)
    : { data: [] as { id: string; full_name: string | null }[] };
  const who = new Map((people ?? []).map((p) => [p.id, p.full_name]));

  const entries: WastageEntry[] = (logs.data ?? []).map((l) => ({
    id: l.id, itemId: l.inventory_item_id, itemName: names.get(l.inventory_item_id) ?? '—', unit: l.unit as BaseUnit,
    location: l.location_kind as LocationKind, qty: Number(l.quantity), costCents: Number(l.cost_cents), reason: l.reason,
    note: l.note, orderId: l.order_id, movedStock: l.moved_stock, recordedBy: l.recorded_by ? who.get(l.recorded_by) ?? 'موظف' : null,
    createdAt: l.created_at,
  }));
  return { entries, summary: summarizeWastage(entries) };
}
