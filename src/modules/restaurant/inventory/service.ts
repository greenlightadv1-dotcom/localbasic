import 'server-only';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { staffDbError, toDataUnavailable } from '@/lib/errors';
import type { TenantContext } from '@/modules/core/tenancy/context';
import type { BaseUnit } from './units';

/**
 * Raw-material inventory (0102/0103). Reads go through the tables' own RLS
 * (inventory.read at this branch); every write is one SECURITY DEFINER
 * function that re-checks the permission, the location and the two-person
 * rules. Nothing here decides who may do what — the database does.
 */

export type LocationKind = 'warehouse' | 'kitchen' | 'bar' | 'transit' | 'waste';
export type StationKind = 'kitchen' | 'bar';

export type InventoryItem = { id: string; name: string; unit: BaseUnit; avgCostCents: number; isActive: boolean };
export type StockAlert = { id: string; itemId: string; kind: 'low' | 'out'; location: LocationKind; qty: number; minQty: number; openedAt: string; acknowledged: boolean };
export type TransferLine = { id: string; itemId: string; issuedQty: number | null; receivedQty: number | null };
export type Transfer = {
  id: string; number: string; to: LocationKind; status: string; note: string | null;
  issuedAt: string; issuedBy: string; receivedAt: string | null; lines: TransferLine[];
};
export type StockRequest = { id: string; location: LocationKind; status: string; note: string | null; createdAt: string; requestedBy: string; lines: { itemId: string; qty: number }[] };
export type WasteRecord = { id: string; itemId: string; location: LocationKind; qty: number; costCents: number; reason: string; note: string | null; createdAt: string };

export type StockOverview = {
  items: InventoryItem[];
  /** levels[kind][itemId] = qty */
  levels: Record<string, Record<string, number>>;
  /** minLevels[kind][itemId] = min */
  minLevels: Record<string, Record<string, number>>;
  alerts: StockAlert[];
  requests: StockRequest[];
  transfers: Transfer[];
  waste: WasteRecord[];
  /** recipes[variantId] = lines */
  recipes: Record<string, { itemId: string; qty: number; locationKind: StationKind | null }[]>;
};

async function locationsByIdForBranch(ctx: TenantContext) {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('inventory_locations').select('id, kind').eq('branch_id', ctx.branchId);
  if (error) throw toDataUnavailable(error, 'inventory locations');
  return new Map((data ?? []).map((l) => [l.id, l.kind as LocationKind]));
}

export async function getStockOverview(ctx: TenantContext): Promise<StockOverview> {
  const supabase = createSupabaseServerClient();
  const locs = await locationsByIdForBranch(ctx);
  const locIds = [...locs.keys()];

  const [items, levels, pars, alerts, requests, transfers, waste, recipes] = await Promise.all([
    supabase.from('inventory_items').select('id, name, unit, avg_cost_cents, is_active')
      .eq('organization_id', ctx.organizationId).order('name'),
    supabase.from('inventory_levels').select('location_id, item_id, qty').eq('branch_id', ctx.branchId),
    locIds.length
      ? supabase.from('inventory_par_levels').select('location_id, item_id, min_qty').in('location_id', locIds)
      : Promise.resolve({ data: [], error: null }),
    supabase.from('inventory_alerts').select('id, item_id, location_id, kind, qty, min_qty, opened_at, acknowledged_at')
      .eq('branch_id', ctx.branchId).is('resolved_at', null).order('opened_at', { ascending: false }),
    supabase.from('inventory_requests').select('id, location_id, status, note, created_at, requested_by')
      .eq('branch_id', ctx.branchId).eq('status', 'open').order('created_at'),
    supabase.from('inventory_transfers').select('id, number, to_location_id, status, note, issued_at, issued_by, received_at')
      .eq('branch_id', ctx.branchId).order('issued_at', { ascending: false }).limit(40),
    supabase.from('inventory_waste').select('id, item_id, location_id, qty, cost_cents, reason, note, created_at')
      .eq('branch_id', ctx.branchId).order('created_at', { ascending: false }).limit(40),
    supabase.from('restaurant_recipe_lines').select('variant_id, item_id, qty, location_kind')
      .eq('organization_id', ctx.organizationId),
  ]);
  for (const r of [items, levels, pars, alerts, requests, transfers, waste, recipes]) {
    if (r.error) throw toDataUnavailable(r.error, 'getStockOverview');
  }

  const reqIds = (requests.data ?? []).map((r) => r.id);
  const trIds = (transfers.data ?? []).map((t) => t.id);
  const [reqLines, trLines] = await Promise.all([
    reqIds.length ? supabase.from('inventory_request_lines').select('request_id, item_id, qty').in('request_id', reqIds)
                  : Promise.resolve({ data: [], error: null }),
    trIds.length ? supabase.from('inventory_transfer_lines').select('id, transfer_id, item_id, issued_qty, received_qty').in('transfer_id', trIds)
                 : Promise.resolve({ data: [], error: null }),
  ]);
  if (reqLines.error) throw toDataUnavailable(reqLines.error, 'request lines');
  if (trLines.error) throw toDataUnavailable(trLines.error, 'transfer lines');

  const kindOf = (id: string) => locs.get(id) ?? 'warehouse';
  const nested = (rows: { location_id: string; item_id: string; v: number }[]) => {
    const out: Record<string, Record<string, number>> = {};
    for (const r of rows) (out[kindOf(r.location_id)] ??= {})[r.item_id] = Number(r.v);
    return out;
  };

  const recipeMap: StockOverview['recipes'] = {};
  for (const r of recipes.data ?? []) {
    (recipeMap[r.variant_id] ??= []).push({ itemId: r.item_id, qty: Number(r.qty), locationKind: r.location_kind });
  }

  return {
    items: (items.data ?? []).map((i) => ({ id: i.id, name: i.name, unit: i.unit, avgCostCents: Number(i.avg_cost_cents), isActive: i.is_active })),
    levels: nested((levels.data ?? []).map((l) => ({ location_id: l.location_id, item_id: l.item_id, v: l.qty }))),
    minLevels: nested(((pars.data ?? []) as { location_id: string; item_id: string; min_qty: number }[])
      .map((p) => ({ location_id: p.location_id, item_id: p.item_id, v: p.min_qty }))),
    alerts: (alerts.data ?? []).map((a) => ({
      id: a.id, itemId: a.item_id, kind: a.kind, location: kindOf(a.location_id), qty: Number(a.qty),
      minQty: Number(a.min_qty), openedAt: a.opened_at, acknowledged: Boolean(a.acknowledged_at),
    })),
    requests: (requests.data ?? []).map((r) => ({
      id: r.id, location: kindOf(r.location_id), status: r.status, note: r.note, createdAt: r.created_at, requestedBy: r.requested_by,
      lines: ((reqLines.data ?? []) as { request_id: string; item_id: string; qty: number }[])
        .filter((l) => l.request_id === r.id).map((l) => ({ itemId: l.item_id, qty: Number(l.qty) })),
    })),
    transfers: (transfers.data ?? []).map((t) => ({
      id: t.id, number: t.number, to: kindOf(t.to_location_id), status: t.status, note: t.note,
      issuedAt: t.issued_at, issuedBy: t.issued_by, receivedAt: t.received_at,
      lines: ((trLines.data ?? []) as { id: string; transfer_id: string; item_id: string; issued_qty: number; received_qty: number | null }[])
        .filter((l) => l.transfer_id === t.id)
        .map((l) => ({ id: l.id, itemId: l.item_id, issuedQty: Number(l.issued_qty), receivedQty: l.received_qty === null ? null : Number(l.received_qty) })),
    })),
    waste: (waste.data ?? []).map((w) => ({
      id: w.id, itemId: w.item_id, location: kindOf(w.location_id), qty: Number(w.qty), costCents: Number(w.cost_cents),
      reason: w.reason, note: w.note, createdAt: w.created_at,
    })),
    recipes: recipeMap,
  };
}

export type IncomingTransfer = { id: string; number: string; issuedAt: string; note: string | null; items: { lineId: string; itemId: string; name: string; unit: BaseUnit }[] };

export type StationView = {
  kind: StationKind;
  items: InventoryItem[];
  levels: Record<string, number>;
  minLevels: Record<string, number>;
  alerts: StockAlert[];
  incoming: IncomingTransfer[];
  requests: StockRequest[];
};

/** What the kitchen or bar sees: its own stock, its alarms, what is on its way to it. */
export async function getStationView(ctx: TenantContext, kind: StationKind): Promise<StationView> {
  const overview = await getStockOverview(ctx);
  const supabase = createSupabaseServerClient();
  const { data: loc } = await supabase.from('inventory_locations').select('id')
    .eq('branch_id', ctx.branchId).eq('kind', kind).maybeSingle();

  let incoming: IncomingTransfer[] = [];
  if (loc) {
    const { data: pending, error } = await supabase.from('inventory_transfers').select('id, number, issued_at, note')
      .eq('to_location_id', loc.id).eq('status', 'issued').order('issued_at');
    if (error) throw toDataUnavailable(error, 'incoming transfers');
    incoming = await Promise.all((pending ?? []).map(async (t) => {
      // Names only: the receiving station counts blind (0102).
      const { data: lines, error: e } = await supabase.rpc('inventory_transfer_items', { p_org: ctx.organizationId, p_transfer: t.id });
      if (e) throw toDataUnavailable(e, 'transfer items');
      const rows = (lines ?? []) as unknown as { out_line_id: string; out_item_id: string; out_name: string; out_unit: BaseUnit }[];
      return {
        id: t.id, number: t.number, issuedAt: t.issued_at, note: t.note,
        items: rows.map((l) => ({ lineId: l.out_line_id, itemId: l.out_item_id, name: l.out_name, unit: l.out_unit })),
      };
    }));
  }

  return {
    kind,
    // Stations see quantities, not what the stock cost.
    items: overview.items.map((i) => ({ ...i, avgCostCents: 0 })),
    levels: overview.levels[kind] ?? {},
    minLevels: overview.minLevels[kind] ?? {},
    alerts: overview.alerts.filter((a) => a.location === kind),
    incoming,
    requests: overview.requests.filter((r) => r.location === kind),
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------
const qty = z.coerce.number().positive('الكمية يجب أن تكون أكبر من صفر').max(100_000_000);
const kindSchema = z.enum(['warehouse', 'kitchen', 'bar']);
const stationSchema = z.enum(['kitchen', 'bar']);
const lines = z.array(z.object({ itemId: z.string().uuid(), qty })).min(1, 'أضف خامة واحدة على الأقل').max(100);

export const itemSchema = z.object({
  id: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1, 'اسم الخامة مطلوب').max(120),
  unit: z.enum(['g', 'ml', 'pc']),
  isActive: z.boolean().default(true),
});
export const parLevelSchema = z.object({ kind: kindSchema, itemId: z.string().uuid(), minQty: z.coerce.number().min(0).nullable() });
export const recipeSchema = z.object({
  variantId: z.string().uuid(),
  lines: z.array(z.object({ itemId: z.string().uuid(), qty, locationKind: stationSchema.nullable().optional() })).max(60),
});
export const stockInSchema = z.object({
  lines: z.array(z.object({ itemId: z.string().uuid(), qty, unitCostCents: z.coerce.number().min(0).max(1_000_000_000).optional() })).min(1).max(100),
  note: z.string().trim().max(300).optional(),
});
export const issueSchema = z.object({ to: stationSchema, lines, requestId: z.string().uuid().nullable().optional(), note: z.string().trim().max(300).optional() });
export const receiveSchema = z.object({
  transferId: z.string().uuid(),
  lines: z.array(z.object({ lineId: z.string().uuid(), receivedQty: z.coerce.number().min(0).max(100_000_000) })).min(1).max(100),
});
export const transferIdSchema = z.object({ transferId: z.string().uuid() });
export const resolveSchema = z.object({ transferId: z.string().uuid(), outcome: z.enum(['found', 'lost']) });
export const requestSchema = z.object({ kind: stationSchema, lines, note: z.string().trim().max(300).optional() });
export const requestIdSchema = z.object({ requestId: z.string().uuid() });
export const wasteSchema = z.object({
  kind: kindSchema, itemId: z.string().uuid(), qty,
  reason: z.enum(['expired', 'spoiled', 'dropped', 'overcooked', 'returned_by_guest', 'staff_meal', 'other']),
  note: z.string().trim().max(300).optional(),
});
export const adjustSchema = z.object({
  kind: kindSchema, itemId: z.string().uuid(),
  delta: z.coerce.number().refine((n) => n !== 0, 'الكمية لا يمكن أن تكون صفرًا').refine((n) => Math.abs(n) <= 100_000_000),
  note: z.string().trim().min(1, 'اكتب سبب التسوية').max(300),
});
export const alertIdSchema = z.object({ alertId: z.string().uuid() });

async function call(fn: string, args: Record<string, unknown>, context: string): Promise<unknown> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc(fn as never, args as never);
  if (error) throw staffDbError(error, context);
  return data;
}

const org = (ctx: TenantContext) => ({ p_org: ctx.organizationId });
const orgBranch = (ctx: TenantContext) => ({ p_org: ctx.organizationId, p_branch: ctx.branchId });
const dbLines = (l: { itemId: string; qty: number }[]) => l.map((x) => ({ item_id: x.itemId, qty: x.qty }));

export const saveItem = (ctx: TenantContext, i: z.infer<typeof itemSchema>) =>
  call('inventory_item_save', { ...org(ctx), p_id: i.id ?? null, p_name: i.name, p_unit: i.unit, p_is_active: i.isActive }, 'saveItem');

export const saveParLevel = (ctx: TenantContext, i: z.infer<typeof parLevelSchema>) =>
  call('inventory_par_level_save', { ...orgBranch(ctx), p_kind: i.kind, p_item: i.itemId, p_min_qty: i.minQty }, 'saveParLevel');

export const saveRecipe = (ctx: TenantContext, i: z.infer<typeof recipeSchema>) =>
  call('restaurant_recipe_save', {
    ...org(ctx), p_variant: i.variantId,
    p_lines: i.lines.map((l) => ({ item_id: l.itemId, qty: l.qty, location_kind: l.locationKind ?? null })),
  }, 'saveRecipe');

export const stockIn = (ctx: TenantContext, i: z.infer<typeof stockInSchema>) =>
  call('inventory_stock_in', {
    ...orgBranch(ctx), p_note: i.note ?? null,
    p_lines: i.lines.map((l) => ({ item_id: l.itemId, qty: l.qty, unit_cost_cents: l.unitCostCents ?? null })),
  }, 'stockIn');

export const issue = (ctx: TenantContext, i: z.infer<typeof issueSchema>) =>
  call('inventory_issue', { ...orgBranch(ctx), p_to_kind: i.to, p_lines: dbLines(i.lines), p_request: i.requestId ?? null, p_note: i.note ?? null }, 'issue');

export async function receive(ctx: TenantContext, i: z.infer<typeof receiveSchema>): Promise<'received' | 'disputed'> {
  const r = await call('inventory_receive', {
    ...org(ctx), p_transfer: i.transferId,
    p_lines: i.lines.map((l) => ({ line_id: l.lineId, received_qty: l.receivedQty })),
  }, 'receive');
  return r === 'disputed' ? 'disputed' : 'received';
}

export const cancelTransfer = (ctx: TenantContext, i: z.infer<typeof transferIdSchema>) =>
  call('inventory_transfer_cancel', { ...org(ctx), p_transfer: i.transferId }, 'cancelTransfer');

export const resolveTransfer = (ctx: TenantContext, i: z.infer<typeof resolveSchema>) =>
  call('inventory_transfer_resolve', { ...org(ctx), p_transfer: i.transferId, p_outcome: i.outcome }, 'resolveTransfer');

export const createRequest = (ctx: TenantContext, i: z.infer<typeof requestSchema>) =>
  call('inventory_request_create', { ...orgBranch(ctx), p_kind: i.kind, p_lines: dbLines(i.lines), p_note: i.note ?? null }, 'createRequest');

export const cancelRequest = (ctx: TenantContext, i: z.infer<typeof requestIdSchema>) =>
  call('inventory_request_cancel', { ...org(ctx), p_request: i.requestId }, 'cancelRequest');

export const recordWaste = (ctx: TenantContext, i: z.infer<typeof wasteSchema>) =>
  call('inventory_record_waste', { ...orgBranch(ctx), p_kind: i.kind, p_item: i.itemId, p_qty: i.qty, p_reason: i.reason, p_note: i.note ?? null }, 'recordWaste');

export const adjust = (ctx: TenantContext, i: z.infer<typeof adjustSchema>) =>
  call('inventory_adjust', { ...orgBranch(ctx), p_kind: i.kind, p_item: i.itemId, p_delta: i.delta, p_note: i.note }, 'adjust');

export const ackAlert = (ctx: TenantContext, i: z.infer<typeof alertIdSchema>) =>
  call('inventory_alert_ack', { ...org(ctx), p_alert: i.alertId }, 'ackAlert');
