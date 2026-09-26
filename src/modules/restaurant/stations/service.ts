import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { toAppError, conflict } from '@/lib/errors';
import type { TenantContext } from '@/modules/core/tenancy/context';
import type { StationKind } from './schemas';

export type Station = {
  id: string;
  name: string;
  kind: StationKind;
  printerIp: string | null;
  printerPort: number;
  isActive: boolean;
  sortOrder: number;
};

export async function listStations(ctx: TenantContext): Promise<Station[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('restaurant_stations')
    .select('id, name, kind, printer_ip, printer_port, is_active, sort_order')
    .eq('organization_id', ctx.organizationId)
    .eq('branch_id', ctx.branchId)
    .order('sort_order')
    .order('name');
  if (error) throw toAppError(error, 'listStations');

  return (data ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind as StationKind,
    printerIp: s.printer_ip,
    printerPort: s.printer_port,
    isActive: s.is_active,
    sortOrder: s.sort_order,
  }));
}

export async function createStation(
  ctx: TenantContext,
  input: { name: string; kind: StationKind; printerIp?: string; printerPort: number; sortOrder: number },
) {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('restaurant_stations')
    .insert({
      organization_id: ctx.organizationId,
      branch_id: ctx.branchId,
      name: input.name,
      kind: input.kind,
      printer_ip: input.printerIp || null,
      printer_port: input.printerPort,
      sort_order: input.sortOrder,
      created_by: ctx.userId,
    })
    .select('id')
    .single();
  if (error?.code === '23505') throw conflict('يوجد محطة بنفس الاسم في هذا الفرع.');
  if (error) throw toAppError(error, 'createStation');
  return data;
}

export async function setStationActive(ctx: TenantContext, stationId: string, isActive: boolean) {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase
    .from('restaurant_stations')
    .update({ is_active: isActive })
    .eq('organization_id', ctx.organizationId)
    .eq('branch_id', ctx.branchId)
    .eq('id', stationId);
  if (error) throw toAppError(error, 'setStationActive');
}

/**
 * Hard delete. Safe: order_items.station_id and products.station_id both
 * reference this table ON DELETE SET NULL (0071) — a deleted station drops
 * off the picker and every item that pointed at it keeps its station_kind,
 * it just loses which physical station printed it.
 */
export async function deleteStation(ctx: TenantContext, stationId: string) {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase
    .from('restaurant_stations')
    .delete()
    .eq('organization_id', ctx.organizationId)
    .eq('branch_id', ctx.branchId)
    .eq('id', stationId);
  if (error) throw toAppError(error, 'deleteStation');
}

/** Manual cashier override: reassign one already-placed order item's station. */
export async function setOrderItemStation(ctx: TenantContext, orderItemId: string, stationId: string) {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('restaurant_set_order_item_station', {
    p_org: ctx.organizationId,
    p_order_item: orderItemId,
    p_station: stationId,
  });
  if (error) throw toAppError(error, 'setOrderItemStation');
}
