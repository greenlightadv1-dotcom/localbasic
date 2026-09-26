import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { TenantContext } from '@/modules/core/tenancy/context';
import { buildKitchenTicket, type Ticket, type TicketLine } from './escpos';
import { printToStation } from './dispatch';

/**
 * Send one ticket per station this order touches to that station's printer.
 *
 * Called once, right after an order is confirmed (see orders/service.ts
 * setOrderStatus) — confirmation is the moment staff have committed to
 * making it, which is when a kitchen or bar actually wants the slip. Every
 * failure here is swallowed and logged: a printer problem is an operational
 * fact for staff to notice on the floor, never a reason the order status
 * change itself should fail.
 */
export async function printConfirmedOrder(ctx: TenantContext, orderId: string): Promise<void> {
  const supabase = createSupabaseServerClient();

  const { data: order } = await supabase
    .from('restaurant_orders')
    .select('number, type, channel, note, placed_at, table_id')
    .eq('organization_id', ctx.organizationId)
    .eq('id', orderId)
    .single();
  if (!order) return;

  const tableName = order.table_id
    ? (
        await supabase
          .from('restaurant_tables')
          .select('name')
          .eq('id', order.table_id)
          .maybeSingle()
      ).data?.name ?? null
    : null;

  const { data: items } = await supabase
    .from('restaurant_order_items')
    .select('id, product_name, variant_name, quantity, note, station_id, station_kind')
    .eq('organization_id', ctx.organizationId)
    .eq('order_id', orderId)
    .order('position');
  if (!items?.length) return;

  const itemIds = items.map((i) => i.id);
  const { data: modifiers } = itemIds.length
    ? await supabase
        .from('restaurant_order_item_modifiers')
        .select('order_item_id, name')
        .in('order_item_id', itemIds)
    : { data: [] as { order_item_id: string; name: string }[] };

  const stationIds = [...new Set(items.map((i) => i.station_id).filter(Boolean))] as string[];
  const { data: stations } = stationIds.length
    ? await supabase
        .from('restaurant_stations')
        .select('id, name, printer_ip, printer_port')
        .in('id', stationIds)
    : { data: [] as { id: string; name: string; printer_ip: string | null; printer_port: number }[] };
  const stationById = new Map((stations ?? []).map((s) => [s.id, s]));

  // Group lines by resolved station. An item with no station_id (no
  // matching station was configured at order time) prints nowhere — there
  // is nothing to send a ticket to — but still shows on the on-screen board
  // grouped by station_kind.
  const byStation = new Map<string, TicketLine[]>();
  for (const item of items) {
    if (!item.station_id) continue;
    const line: TicketLine = {
      productName: item.product_name,
      variantName: item.variant_name,
      quantity: Number(item.quantity),
      note: item.note,
      modifiers: (modifiers ?? [])
        .filter((m) => m.order_item_id === item.id)
        .map((m) => m.name),
    };
    byStation.set(item.station_id, [...(byStation.get(item.station_id) ?? []), line]);
  }

  // Awaited, not fire-and-forget: a serverless invocation can be frozen the
  // instant this function returns, which would silently drop an unawaited
  // socket write. printToStation() itself never rejects and has its own
  // short timeout, so this adds at most ~4s per distinct station, in
  // parallel, never per line.
  await Promise.allSettled(
    [...byStation.entries()].map(([stationId, lines]) => {
      const station = stationById.get(stationId);
      if (!station?.printer_ip) return Promise.resolve();

      const ticket: Ticket = {
        stationName: station.name,
        orderNumber: order.number,
        orderType: order.type,
        tableName,
        channel: order.channel,
        placedAt: new Date(order.placed_at),
        note: order.note,
        lines,
      };

      return printToStation(station.printer_ip, station.printer_port, buildKitchenTicket(ticket)).then(
        (ok) => {
          if (!ok) {
            console.error(
              `[printing] failed to print order ${order.number} to station ${station.name} (${station.printer_ip}:${station.printer_port})`,
            );
          }
        },
      );
    }),
  );
}
