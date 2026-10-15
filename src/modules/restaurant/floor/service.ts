import 'server-only';
import type { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { staffDbError, toDataUnavailable } from '@/lib/errors';
import type { TenantContext } from '@/modules/core/tenancy/context';
import type { TableStatus } from '@/modules/restaurant/tables/schemas';
import type {
  layoutSchema, mergeSchema, seatSchema, splitSchema, TableShape, transferSchema,
  waitlistActionSchema, waitlistAddSchema,
} from './schemas';

/**
 * The dining floor (0105). Reads go through each table's own RLS; every
 * operation that moves an order, a line or a guest is one SECURITY DEFINER
 * function that re-checks the permission, the zone, the approval and the
 * inventory rules in the same transaction.
 */

export type FloorOrder = {
  id: string;
  number: string;
  status: string;
  totalCents: number;
  invoiceId: string | null;
  placedAt: string;
};

export type FloorPlanTable = {
  id: string;
  name: string;
  seats: number;
  status: TableStatus;
  sectionId: string | null;
  x: number | null;
  y: number | null;
  w: number;
  h: number;
  shape: TableShape;
  mergedInto: string | null;
  orders: FloorOrder[];
  heldFor: string | null;
};

export type FloorSection = { id: string; name: string; sortOrder: number };

export type FloorPlan = { sections: FloorSection[]; tables: FloorPlanTable[] };

export async function getFloorPlan(ctx: TenantContext): Promise<FloorPlan> {
  const supabase = createSupabaseServerClient();
  const canWaitlist = ctx.permissions.has('restaurant.waitlist.manage');
  const [tables, sections, orders, holds] = await Promise.all([
    supabase
      .from('restaurant_tables')
      .select('id, name, seats, status, section_id, layout_x, layout_y, layout_w, layout_h, shape, merged_into')
      .eq('organization_id', ctx.organizationId)
      .eq('branch_id', ctx.branchId)
      .is('deleted_at', null)
      .eq('is_active', true)
      .order('name'),
    supabase
      .from('restaurant_sections')
      .select('id, name, sort_order')
      .eq('branch_id', ctx.branchId)
      .eq('is_active', true)
      .order('sort_order'),
    supabase
      .from('restaurant_orders')
      .select('id, number, status, table_id, total_cents, invoice_id, placed_at')
      .eq('branch_id', ctx.branchId)
      .not('table_id', 'is', null)
      .in('status', ['new', 'confirmed', 'preparing', 'ready', 'served'])
      .order('placed_at'),
    canWaitlist
      ? supabase
          .from('restaurant_waitlist')
          .select('table_id, guest_name')
          .eq('branch_id', ctx.branchId)
          .in('status', ['waiting', 'notified'])
          .not('table_id', 'is', null)
      : Promise.resolve({ data: [] as { table_id: string | null; guest_name: string }[], error: null }),
  ]);
  if (tables.error) throw toDataUnavailable(tables.error, 'getFloorPlan');
  if (sections.error) throw toDataUnavailable(sections.error, 'getFloorPlan sections');
  if (orders.error) throw toDataUnavailable(orders.error, 'getFloorPlan orders');

  const heldBy = new Map((holds.data ?? []).map((h) => [h.table_id, h.guest_name]));
  return {
    sections: (sections.data ?? []).map((s) => ({ id: s.id, name: s.name, sortOrder: s.sort_order })),
    tables: (tables.data ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      seats: t.seats,
      status: t.status as TableStatus,
      sectionId: t.section_id,
      x: t.layout_x === null ? null : Number(t.layout_x),
      y: t.layout_y === null ? null : Number(t.layout_y),
      w: Number(t.layout_w),
      h: Number(t.layout_h),
      shape: t.shape as TableShape,
      mergedInto: t.merged_into,
      orders: (orders.data ?? [])
        .filter((o) => o.table_id === t.id)
        .map((o) => ({
          id: o.id, number: o.number, status: o.status, totalCents: o.total_cents,
          invoiceId: o.invoice_id, placedAt: o.placed_at,
        })),
      heldFor: heldBy.get(t.id) ?? null,
    })),
  };
}

export type CheckLine = {
  id: string;
  productName: string;
  variantName: string;
  quantity: number;
  lineTotalCents: number;
  seatNo: number | null;
  prepStatus: string;
  modifiers: string[];
};

/** One check's lines, for the split dialog. */
export async function getCheckLines(ctx: TenantContext, orderId: string): Promise<CheckLine[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('restaurant_order_items')
    .select('id, product_name, variant_name, quantity, line_total_cents, seat_no, prep_status, order_id')
    .eq('organization_id', ctx.organizationId)
    .eq('order_id', orderId)
    .order('position');
  if (error) throw staffDbError(error, 'getCheckLines');
  const ids = (data ?? []).map((l) => l.id);
  const { data: mods } = ids.length
    ? await supabase.from('restaurant_order_item_modifiers').select('order_item_id, name').in('order_item_id', ids)
    : { data: [] as { order_item_id: string; name: string }[] };
  return (data ?? []).map((l) => ({
    id: l.id,
    productName: l.product_name,
    variantName: l.variant_name,
    quantity: Number(l.quantity),
    lineTotalCents: l.line_total_cents,
    seatNo: l.seat_no,
    prepStatus: l.prep_status,
    modifiers: (mods ?? []).filter((m) => m.order_item_id === l.id).map((m) => m.name),
  }));
}

async function call(fn: string, args: Record<string, unknown>, context: string): Promise<unknown> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc(fn as never, args as never);
  if (error) throw staffDbError(error, context);
  return data;
}

export const saveLayout = (ctx: TenantContext, i: z.infer<typeof layoutSchema>) =>
  call('restaurant_floor_layout_save', {
    p_org: ctx.organizationId, p_branch: ctx.branchId,
    p_tables: i.tables.map((t) => ({ id: t.id, section_id: t.sectionId, x: t.x, y: t.y, w: t.w, h: t.h, shape: t.shape })),
  }, 'saveLayout');

export const transferTable = (ctx: TenantContext, i: z.infer<typeof transferSchema>) =>
  call('restaurant_table_transfer', {
    p_org: ctx.organizationId, p_from: i.fromTableId, p_to: i.toTableId, p_order: i.orderId ?? null,
  }, 'transferTable') as Promise<number>;

export const mergeTables = (ctx: TenantContext, i: z.infer<typeof mergeSchema>) =>
  call('restaurant_table_merge', {
    p_org: ctx.organizationId, p_target: i.targetTableId, p_sources: i.sourceTableIds,
  }, 'mergeTables') as Promise<string | null>;

export const unmergeTable = (ctx: TenantContext, tableId: string) =>
  call('restaurant_table_unmerge', { p_org: ctx.organizationId, p_table: tableId }, 'unmergeTable');

export async function splitCheck(ctx: TenantContext, i: z.infer<typeof splitSchema>) {
  const data = await call('restaurant_check_split', {
    p_org: ctx.organizationId, p_order: i.orderId,
    p_lines: i.lines.map((l) => ({ item_id: l.itemId, qty: l.qty })),
  }, 'splitCheck');
  const row = (Array.isArray(data) ? data[0] : data) as { out_order_id: string; out_number: string };
  return { orderId: row.out_order_id, number: row.out_number };
}

export const setSeat = (ctx: TenantContext, i: z.infer<typeof seatSchema>) =>
  call('restaurant_order_item_set_seat', { p_org: ctx.organizationId, p_items: i.itemIds, p_seat: i.seat }, 'setSeat');

// ---------------------------------------------------------------------------
// Waiting list
// ---------------------------------------------------------------------------
export type WaitlistEntry = {
  id: string;
  kind: 'walk_in' | 'reservation';
  guestName: string;
  guestPhone: string | null;
  partySize: number;
  reservedFor: string | null;
  status: 'waiting' | 'notified';
  tableId: string | null;
  quotedWaitMin: number | null;
  note: string | null;
  createdAt: string;
  notifiedAt: string | null;
};

export async function listWaitlist(ctx: TenantContext): Promise<{ open: WaitlistEntry[]; seatedToday: number }> {
  const supabase = createSupabaseServerClient();
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const [open, seated] = await Promise.all([
    supabase
      .from('restaurant_waitlist')
      .select('id, kind, guest_name, guest_phone, party_size, reserved_for, status, table_id, quoted_wait_min, note, created_at, notified_at')
      .eq('branch_id', ctx.branchId)
      .in('status', ['waiting', 'notified'])
      .order('created_at')
      .limit(200),
    supabase
      .from('restaurant_waitlist')
      .select('id', { count: 'exact', head: true })
      .eq('branch_id', ctx.branchId)
      .eq('status', 'seated')
      .gte('seated_at', since.toISOString()),
  ]);
  if (open.error) throw toDataUnavailable(open.error, 'listWaitlist');
  return {
    open: (open.data ?? []).map((w) => ({
      id: w.id,
      kind: w.kind as WaitlistEntry['kind'],
      guestName: w.guest_name,
      guestPhone: w.guest_phone,
      partySize: w.party_size,
      reservedFor: w.reserved_for,
      status: w.status as WaitlistEntry['status'],
      tableId: w.table_id,
      quotedWaitMin: w.quoted_wait_min,
      note: w.note,
      createdAt: w.created_at,
      notifiedAt: w.notified_at,
    })),
    seatedToday: seated.count ?? 0,
  };
}

export async function addToWaitlist(ctx: TenantContext, i: z.infer<typeof waitlistAddSchema>) {
  const data = await call('restaurant_waitlist_add', {
    p_org: ctx.organizationId, p_branch: ctx.branchId, p_name: i.guestName, p_phone: i.guestPhone || null,
    p_party: i.partySize, p_kind: i.kind, p_reserved_for: i.kind === 'reservation' ? i.reservedFor : null,
    p_note: i.note || null,
  }, 'addToWaitlist');
  const row = (Array.isArray(data) ? data[0] : data) as { out_id: string; out_quoted_min: number | null };
  return { id: row.out_id, quotedMin: row.out_quoted_min };
}

export const waitlistAction = (ctx: TenantContext, i: z.infer<typeof waitlistActionSchema>) =>
  call('restaurant_waitlist_action', {
    p_org: ctx.organizationId, p_id: i.id, p_action: i.action, p_table: i.tableId ?? null,
  }, 'waitlistAction');

export const estimateWait = (ctx: TenantContext, partySize: number) =>
  call('restaurant_waitlist_estimate', {
    p_org: ctx.organizationId, p_branch: ctx.branchId, p_party: partySize,
  }, 'estimateWait') as Promise<number | null>;
