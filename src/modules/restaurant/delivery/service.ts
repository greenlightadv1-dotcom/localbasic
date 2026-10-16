import 'server-only';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { staffDbError, toDataUnavailable } from '@/lib/errors';
import type { TenantContext } from '@/modules/core/tenancy/context';

/**
 * Delivery & fleet (0106). Reads go through RLS (fleet readers, or the
 * driver for their own rows); every write is one SECURITY DEFINER function
 * that re-checks the permission, the trip's state and, for money, the
 * manager-PIN rule.
 */

export type Zone = { id: string; name: string; feeCents: number; driverFeeCents: number; isActive: boolean };
export type Driver = {
  id: string; name: string; phone: string | null; vehicle: string | null; memberId: string | null;
  mode: 'zone' | 'percent' | 'fixed'; percentBp: number; fixedCents: number;
  onShift: boolean; isActive: boolean; custodyCents: number; commissionCents: number; activeTrips: number;
};
export type JobStatus = 'pending' | 'assigned' | 'dispatched' | 'in_transit' | 'delivered' | 'returned' | 'cancelled';
export type DispatchOrder = {
  orderId: string; number: string; orderStatus: string; channel: string; placedAt: string; totalCents: number;
  paidCents: number; guestName: string | null; guestPhone: string | null;
  address: { recipient: string; phone: string; area: string | null; city: string | null; address: string; landmark: string | null; notes: string | null } | null;
  job: { status: JobStatus; driverId: string | null; zoneId: string | null; cashToCollectCents: number; commissionCents: number;
         dispatchedAt: string | null; deliveredAt: string | null; settledAt: string | null } | null;
};

const LIVE = ['new', 'confirmed', 'preparing', 'ready', 'served'];

export async function listZones(ctx: TenantContext): Promise<Zone[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.from('restaurant_delivery_zones')
    .select('id, name, fee_cents, driver_fee_cents, is_active').eq('branch_id', ctx.branchId).order('sort_order').order('name');
  if (error) throw toDataUnavailable(error, 'listZones');
  return (data ?? []).map((z) => ({ id: z.id, name: z.name, feeCents: z.fee_cents, driverFeeCents: z.driver_fee_cents, isActive: z.is_active }));
}

export async function listDrivers(ctx: TenantContext): Promise<Driver[]> {
  const supabase = createSupabaseServerClient();
  const [drivers, ledger, jobs] = await Promise.all([
    supabase.from('restaurant_drivers')
      .select('id, name, phone, vehicle, member_id, commission_mode, commission_percent_bp, commission_fixed_cents, on_shift, is_active')
      .eq('branch_id', ctx.branchId).order('name'),
    supabase.from('restaurant_driver_ledger').select('driver_id, kind, amount_cents').eq('branch_id', ctx.branchId),
    supabase.from('restaurant_delivery_jobs').select('driver_id, status').eq('branch_id', ctx.branchId).in('status', ['assigned', 'dispatched', 'in_transit']),
  ]);
  if (drivers.error) throw toDataUnavailable(drivers.error, 'listDrivers');
  const custody = new Map<string, number>();
  const commission = new Map<string, number>();
  for (const e of ledger.data ?? []) {
    const c = { float_out: 1, collect: 1, settle: -1, shortage: -1 }[e.kind as string];
    const k = { commission: 1, payout: -1, commission_adjust: 1 }[e.kind as string];
    if (c) custody.set(e.driver_id, (custody.get(e.driver_id) ?? 0) + c * e.amount_cents);
    if (k) commission.set(e.driver_id, (commission.get(e.driver_id) ?? 0) + k * e.amount_cents);
  }
  return (drivers.data ?? []).map((d) => ({
    id: d.id, name: d.name, phone: d.phone, vehicle: d.vehicle, memberId: d.member_id,
    mode: d.commission_mode as Driver['mode'], percentBp: d.commission_percent_bp, fixedCents: d.commission_fixed_cents,
    onShift: d.on_shift, isActive: d.is_active,
    custodyCents: custody.get(d.id) ?? 0, commissionCents: commission.get(d.id) ?? 0,
    activeTrips: (jobs.data ?? []).filter((j) => j.driver_id === d.id).length,
  }));
}

/** Delivery orders still in play, plus delivered ones awaiting settlement. */
export async function getDispatchBoard(ctx: TenantContext, opts: { driverId?: string } = {}): Promise<DispatchOrder[]> {
  const supabase = createSupabaseServerClient();
  let jobsQuery = supabase.from('restaurant_delivery_jobs')
    .select('order_id, status, driver_id, zone_id, cash_to_collect_cents, commission_cents, dispatched_at, delivered_at, settled_at')
    .eq('branch_id', ctx.branchId);
  if (opts.driverId) jobsQuery = jobsQuery.eq('driver_id', opts.driverId);
  const [orders, jobs] = await Promise.all([
    supabase.from('restaurant_orders')
      .select('id, number, status, channel, placed_at, total_cents, invoice_id, guest_name, guest_phone')
      .eq('branch_id', ctx.branchId).eq('type', 'delivery').in('status', LIVE)
      .order('placed_at').limit(300),
    jobsQuery.or('settled_at.is.null,status.in.(pending,assigned,dispatched,in_transit)').limit(500),
  ]);
  if (orders.error) throw toDataUnavailable(orders.error, 'getDispatchBoard');
  const jobByOrder = new Map((jobs.data ?? []).map((j) => [j.order_id, j]));
  // Delivered but unsettled orders may already be 'served'/'completed' — include those too.
  const extraIds = (jobs.data ?? []).filter((j) => j.status === 'delivered' && !j.settled_at).map((j) => j.order_id)
    .filter((id) => !(orders.data ?? []).some((o) => o.id === id));
  const extra = extraIds.length
    ? (await supabase.from('restaurant_orders').select('id, number, status, channel, placed_at, total_cents, invoice_id, guest_name, guest_phone').in('id', extraIds)).data ?? []
    : [];
  let rows = [...(orders.data ?? []), ...extra];
  if (opts.driverId) rows = rows.filter((o) => jobByOrder.has(o.id));
  const ids = rows.map((o) => o.id);
  const invoiceIds = rows.map((o) => o.invoice_id).filter(Boolean) as string[];
  const [addresses, invoices] = await Promise.all([
    ids.length ? supabase.from('restaurant_order_deliveries').select('order_id, recipient_name, phone, area, city, address, landmark, notes').in('order_id', ids)
               : Promise.resolve({ data: [] as never[] }),
    invoiceIds.length ? supabase.from('invoices').select('id, paid_cents').in('id', invoiceIds) : Promise.resolve({ data: [] as never[] }),
  ]);
  const addrByOrder = new Map(((addresses.data ?? []) as { order_id: string; recipient_name: string; phone: string; area: string | null; city: string | null; address: string; landmark: string | null; notes: string | null }[]).map((a) => [a.order_id, a]));
  const paid = new Map(((invoices.data ?? []) as { id: string; paid_cents: number }[]).map((i) => [i.id, i.paid_cents]));
  return rows.map((o) => {
    const a = addrByOrder.get(o.id);
    const j = jobByOrder.get(o.id);
    return {
      orderId: o.id, number: o.number, orderStatus: o.status, channel: o.channel, placedAt: o.placed_at, totalCents: o.total_cents,
      paidCents: o.invoice_id ? paid.get(o.invoice_id) ?? 0 : 0, guestName: o.guest_name, guestPhone: o.guest_phone,
      address: a ? { recipient: a.recipient_name, phone: a.phone, area: a.area, city: a.city, address: a.address, landmark: a.landmark, notes: a.notes } : null,
      job: j ? {
        status: j.status as JobStatus, driverId: j.driver_id, zoneId: j.zone_id, cashToCollectCents: j.cash_to_collect_cents,
        commissionCents: j.commission_cents, dispatchedAt: j.dispatched_at, deliveredAt: j.delivered_at, settledAt: j.settled_at,
      } : null,
    };
  });
}

/** The signed-in driver's own driver row at this branch, if any. */
export async function getMyDriver(ctx: TenantContext): Promise<Driver | null> {
  const supabase = createSupabaseServerClient();
  const { data: member } = await supabase.from('organization_members').select('id')
    .eq('organization_id', ctx.organizationId).eq('user_id', ctx.userId).maybeSingle();
  if (!member) return null;
  const { data } = await supabase.from('restaurant_drivers').select('id').eq('branch_id', ctx.branchId).eq('member_id', member.id).maybeSingle();
  if (!data) return null;
  const all = await listDriversForSelf(ctx, data.id);
  return all;
}

async function listDriversForSelf(ctx: TenantContext, driverId: string): Promise<Driver | null> {
  const supabase = createSupabaseServerClient();
  const [{ data: d }, { data: ledger }] = await Promise.all([
    supabase.from('restaurant_drivers')
      .select('id, name, phone, vehicle, member_id, commission_mode, commission_percent_bp, commission_fixed_cents, on_shift, is_active')
      .eq('id', driverId).maybeSingle(),
    supabase.from('restaurant_driver_ledger').select('kind, amount_cents').eq('driver_id', driverId),
  ]);
  if (!d) return null;
  let custody = 0; let commission = 0;
  for (const e of ledger ?? []) {
    custody += ({ float_out: 1, collect: 1, settle: -1, shortage: -1 }[e.kind as string] ?? 0) * e.amount_cents;
    commission += ({ commission: 1, payout: -1, commission_adjust: 1 }[e.kind as string] ?? 0) * e.amount_cents;
  }
  return {
    id: d.id, name: d.name, phone: d.phone, vehicle: d.vehicle, memberId: d.member_id, mode: d.commission_mode as Driver['mode'],
    percentBp: d.commission_percent_bp, fixedCents: d.commission_fixed_cents, onShift: d.on_shift, isActive: d.is_active,
    custodyCents: custody, commissionCents: commission, activeTrips: 0,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------
const cents = z.coerce.number().int().min(0).max(100_000_000);
export const zoneSchema = z.object({ id: z.string().uuid().nullable(), name: z.string().trim().min(1, 'اسم المنطقة مطلوب').max(80), feeCents: cents, driverFeeCents: cents, isActive: z.boolean().default(true) });
export const driverSchema = z.object({
  id: z.string().uuid().nullable(), name: z.string().trim().min(1, 'اسم المندوب مطلوب').max(80),
  phone: z.string().trim().max(30).optional().or(z.literal('')), vehicle: z.string().trim().max(60).optional().or(z.literal('')),
  memberId: z.string().uuid().nullable(), mode: z.enum(['zone', 'percent', 'fixed']),
  percentBp: z.coerce.number().int().min(0).max(10000).default(0), fixedCents: cents.default(0), isActive: z.boolean().default(true),
});
export const shiftSchema = z.object({ driverId: z.string().uuid(), on: z.boolean() });
export const assignSchema = z.object({ orderId: z.string().uuid(), driverId: z.string().uuid().nullable(), zoneId: z.string().uuid().nullable().optional() });
export const statusSchema = z.object({ orderId: z.string().uuid(), status: z.enum(['dispatched', 'in_transit', 'delivered', 'returned']), reason: z.string().trim().max(300).optional() });
export const floatSchema = z.object({ driverId: z.string().uuid(), amountCents: z.coerce.number().int().min(1).max(100_000_000), note: z.string().trim().max(300).optional() });
export const settleSchema = z.object({ driverId: z.string().uuid(), cashCents: cents, payCommission: z.boolean().default(false) });
export const driverAdjustSchema = z.object({ driverId: z.string().uuid(), amountCents: z.coerce.number().int().refine((n) => n !== 0, 'المبلغ لا يمكن أن يكون صفرًا'), note: z.string().trim().min(1, 'اكتب السبب').max(300) });

async function call(fn: string, args: Record<string, unknown>, context: string): Promise<unknown> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc(fn as never, args as never);
  if (error) throw staffDbError(error, context);
  return data;
}

export const saveZone = (ctx: TenantContext, i: z.infer<typeof zoneSchema>) =>
  call('restaurant_delivery_zone_save', { p_org: ctx.organizationId, p_branch: ctx.branchId, p_id: i.id, p_name: i.name, p_fee_cents: i.feeCents, p_driver_fee_cents: i.driverFeeCents, p_is_active: i.isActive }, 'saveZone');
export const saveDriver = (ctx: TenantContext, i: z.infer<typeof driverSchema>) =>
  call('restaurant_driver_save', { p_org: ctx.organizationId, p_branch: ctx.branchId, p_id: i.id, p_name: i.name, p_phone: i.phone || null, p_member: i.memberId, p_vehicle: i.vehicle || null, p_mode: i.mode, p_percent_bp: i.percentBp, p_fixed_cents: i.fixedCents, p_is_active: i.isActive }, 'saveDriver');
export const setShift = (ctx: TenantContext, i: z.infer<typeof shiftSchema>) =>
  call('restaurant_driver_shift', { p_org: ctx.organizationId, p_driver: i.driverId, p_on: i.on }, 'setShift');
export const assign = (ctx: TenantContext, i: z.infer<typeof assignSchema>) =>
  call('restaurant_delivery_assign', { p_org: ctx.organizationId, p_order: i.orderId, p_driver: i.driverId, p_zone: i.zoneId ?? null }, 'assign');
export const setStatus = (ctx: TenantContext, i: z.infer<typeof statusSchema>) =>
  call('restaurant_delivery_status', { p_org: ctx.organizationId, p_order: i.orderId, p_status: i.status, p_reason: i.reason ?? null }, 'setDeliveryStatus');
export const giveFloat = (ctx: TenantContext, i: z.infer<typeof floatSchema>) =>
  call('restaurant_driver_float', { p_org: ctx.organizationId, p_driver: i.driverId, p_amount: i.amountCents, p_note: i.note ?? null }, 'giveFloat');
export const settle = (ctx: TenantContext, i: z.infer<typeof settleSchema>) =>
  call('restaurant_driver_settle', { p_org: ctx.organizationId, p_driver: i.driverId, p_cash_cents: i.cashCents, p_pay_commission: i.payCommission }, 'settle') as Promise<{ orders: number; collected: number; shortage: number; commission_paid: number }>;
export const adjustDriver = (ctx: TenantContext, i: z.infer<typeof driverAdjustSchema>) =>
  call('restaurant_driver_adjust', { p_org: ctx.organizationId, p_driver: i.driverId, p_amount: i.amountCents, p_note: i.note }, 'adjustDriver');

/** Staff members who could be linked to a driver row (anyone with the driver role). */
export async function listDriverMembers(ctx: TenantContext): Promise<{ memberId: string; name: string }[]> {
  const supabase = createSupabaseServerClient();
  const { data: role } = await supabase.from('roles').select('id').eq('organization_id', ctx.organizationId).eq('key', 'driver').maybeSingle();
  if (!role) return [];
  const { data: links } = await supabase.from('user_roles').select('member_id').eq('role_id', role.id);
  const ids = (links ?? []).map((l) => l.member_id);
  if (!ids.length) return [];
  const { data: members } = await supabase.from('organization_members').select('id, user_id').in('id', ids).eq('status', 'active');
  const userIds = (members ?? []).map((m) => m.user_id);
  const { data: profiles } = userIds.length ? await supabase.from('profiles').select('id, full_name').in('id', userIds) : { data: [] as { id: string; full_name: string | null }[] };
  return (members ?? []).map((m) => ({ memberId: m.id, name: profiles?.find((p) => p.id === m.user_id)?.full_name || 'موظف' }));
}
