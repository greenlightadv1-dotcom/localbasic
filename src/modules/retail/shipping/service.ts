import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AppError, toAppError } from '@/lib/errors';
import { requirePermission, type TenantContext } from '@/modules/core/tenancy/context';
import { getCarrier, type Parcel } from './carrier';

/**
 * Shipping.
 *
 * The database owns the parcel: it copies the address from the order, enforces
 * the state machine, and records the carrier cost against the treasury. This
 * layer decides which ADAPTER to ask, hands it the snapshot the database
 * produced, and writes back only what the carrier actually said.
 *
 * Booking is deliberately split in two — the shipment exists first, then the
 * carrier is asked. A carrier that fails or is slow leaves a parcel the shop
 * can still move by hand, instead of losing the record entirely.
 */

export const SHIPMENT_STATUSES = [
  'pending', 'dispatched', 'delivered', 'failed', 'cancelled',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const SHIPMENT_STATUS_LABELS: Record<ShipmentStatus, string> = {
  pending: 'بانتظار الإرسال',
  dispatched: 'في الطريق',
  delivered: 'تم التسليم',
  failed: 'تعذّر التسليم',
  cancelled: 'ملغاة',
};

export type ShippingProvider = {
  id: string;
  providerKey: string;
  name: string;
  defaultCostCents: number;
  phone: string | null;
  isActive: boolean;
};

export type Shipment = {
  id: string;
  orderId: string;
  providerKey: string;
  providerName: string | null;
  status: ShipmentStatus;
  trackingCode: string | null;
  trackingUrl: string | null;
  costCents: number;
  currency: string;
  recipientName: string;
  phone: string;
  city: string;
  addressLine: string;
  failureReason: string | null;
  createdAt: string;
  paidCents: number;
};

function rows<T>(data: unknown): T[] {
  return (Array.isArray(data) ? data : data == null ? [] : [data]) as T[];
}

function asStatus(value: string): ShipmentStatus {
  return (SHIPMENT_STATUSES as readonly string[]).includes(value)
    ? (value as ShipmentStatus)
    : 'pending';
}

export async function listProviders(
  ctx: TenantContext,
  options: { includeInactive?: boolean } = {},
): Promise<ShippingProvider[]> {
  requirePermission(ctx, 'retail.order.read');
  const supabase = createSupabaseServerClient();

  let query = supabase
    .from('retail_shipping_providers')
    .select('id, provider_key, name, default_cost_cents, phone, is_active')
    .eq('organization_id', ctx.organizationId)
    .order('name')
    .limit(100);
  if (!options.includeInactive) query = query.eq('is_active', true);

  const { data, error } = await query;
  if (error) throw toAppError(error, 'listProviders');

  return (data ?? []).map((p) => ({
    id: p.id,
    providerKey: p.provider_key,
    name: p.name,
    defaultCostCents: Number(p.default_cost_cents),
    phone: p.phone,
    isActive: p.is_active,
  }));
}

export async function createProvider(
  ctx: TenantContext,
  input: { name: string; providerKey?: string; defaultCostCents: number; phone?: string },
): Promise<string> {
  requirePermission(ctx, 'settings.manage');
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from('retail_shipping_providers')
    .insert({
      organization_id: ctx.organizationId,
      // Only a key this deployment can honour. A shop cannot name a courier
      // the application has no adapter for and then wonder why nothing books.
      provider_key: input.providerKey ?? 'manual',
      name: input.name,
      default_cost_cents: Math.max(0, Math.round(input.defaultCostCents)),
      phone: input.phone || null,
      created_by: ctx.userId,
    })
    .select('id')
    .single();

  if (error) throw toAppError(error, 'createProvider');
  return data.id;
}

/** Parcels for one order, newest first — including the failed attempts. */
export async function listShipments(
  ctx: TenantContext,
  orderId: string,
): Promise<Shipment[]> {
  requirePermission(ctx, 'retail.order.read');
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from('retail_shipments')
    .select('id, order_id, provider_key, status, tracking_code, tracking_url, cost_cents, currency, recipient_name, phone, city, address_line, failure_reason, created_at, retail_shipping_providers(name)')
    .eq('organization_id', ctx.organizationId)
    .eq('branch_id', ctx.branchId)
    .eq('order_id', orderId)
    .order('created_at', { ascending: false });

  if (error) throw toAppError(error, 'listShipments');
  if (!data?.length) return [];

  // What has actually been paid out, read back from the treasury rather than
  // stored on the shipment — the same rule purchase payments follow.
  const { data: paid } = await supabase
    .from('treasury_transactions')
    .select('ref_id, amount_cents')
    .eq('organization_id', ctx.organizationId)
    .eq('ref_type', 'retail_shipment')
    .in('ref_id', data.map((s) => s.id));

  const paidById = new Map<string, number>();
  for (const t of paid ?? []) {
    paidById.set(t.ref_id as string, (paidById.get(t.ref_id as string) ?? 0) + t.amount_cents);
  }

  return data.map((s) => {
    const provider = s.retail_shipping_providers as unknown as { name: string } | null;
    return {
      id: s.id,
      orderId: s.order_id,
      providerKey: s.provider_key,
      providerName: provider?.name ?? null,
      status: asStatus(s.status),
      trackingCode: s.tracking_code,
      trackingUrl: s.tracking_url,
      costCents: Number(s.cost_cents),
      currency: s.currency,
      recipientName: s.recipient_name,
      phone: s.phone,
      city: s.city,
      addressLine: s.address_line,
      failureReason: s.failure_reason,
      createdAt: s.created_at,
      paidCents: paidById.get(s.id) ?? 0,
    };
  });
}

/**
 * Create the parcel, then offer it to the carrier.
 *
 * In that order, deliberately. The shipment is the shop's record and must
 * exist whether or not the carrier answers; the booking is an enrichment. A
 * carrier that throws leaves a pending parcel a human can carry, which is what
 * every shop did before software.
 */
export async function createShipment(
  ctx: TenantContext,
  input: {
    orderId: string;
    providerId?: string | null;
    costCents?: number | null;
    trackingCode?: string;
    note?: string;
  },
): Promise<{ id: string; providerKey: string; booked: boolean }> {
  requirePermission(ctx, 'retail.order.manage');
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase.rpc('retail_shipment_create', {
    p_org: ctx.organizationId,
    p_branch: ctx.branchId,
    p_order: input.orderId,
    p_provider: input.providerId || null,
    p_cost_cents: input.costCents ?? null,
    p_tracking_code: input.trackingCode || null,
    p_note: input.note || null,
  });
  if (error) throw new AppError('validation', error.message);

  const row = rows<{ out_id: string; out_provider_key: string }>(data)[0];
  if (!row?.out_id) throw new AppError('validation', 'تعذّر إنشاء الشحنة');

  const shipments = await listShipments(ctx, input.orderId);
  const created = shipments.find((s) => s.id === row.out_id);
  if (!created) return { id: row.out_id, providerKey: row.out_provider_key, booked: false };

  const parcel: Parcel = {
    shipmentId: created.id,
    orderNumber: input.orderId,
    address: {
      recipientName: created.recipientName,
      phone: created.phone,
      city: created.city,
      addressLine: created.addressLine,
    },
    costCents: created.costCents,
    currency: created.currency,
    note: input.note ?? null,
  };

  let booked = false;
  try {
    const booking = await getCarrier(row.out_provider_key).book(parcel);
    // Only what the carrier actually returned. A manual carrier returns
    // nothing, and nothing is written.
    if (booking.trackingCode) {
      await setTracking(ctx, created.id, booking.trackingCode, booking.trackingUrl ?? undefined);
      booked = true;
    }
  } catch {
    // The parcel exists and can be moved by hand. Losing the record because a
    // courier's API was down would be the worse failure.
  }

  return { id: row.out_id, providerKey: row.out_provider_key, booked };
}

export async function setShipmentStatus(
  ctx: TenantContext,
  shipmentId: string,
  status: 'dispatched' | 'delivered' | 'failed' | 'cancelled',
  reason?: string,
): Promise<void> {
  requirePermission(ctx, 'retail.order.manage');
  const supabase = createSupabaseServerClient();

  const { error } = await supabase.rpc('retail_shipment_set_status', {
    p_org: ctx.organizationId,
    p_branch: ctx.branchId,
    p_shipment: shipmentId,
    p_status: status,
    p_reason: reason || null,
  });
  if (error) throw new AppError('validation', error.message);
}

export async function setTracking(
  ctx: TenantContext,
  shipmentId: string,
  code: string,
  url?: string,
): Promise<void> {
  requirePermission(ctx, 'retail.order.manage');
  const supabase = createSupabaseServerClient();

  const { error } = await supabase.rpc('retail_shipment_set_tracking', {
    p_org: ctx.organizationId,
    p_branch: ctx.branchId,
    p_shipment: shipmentId,
    p_code: code,
    p_url: url || null,
  });
  if (error) throw new AppError('validation', error.message);
}

/** Settle what the shop owes the carrier. Money out of the treasury. */
export async function payShipment(ctx: TenantContext, shipmentId: string): Promise<number> {
  requirePermission(ctx, 'retail.order.manage');
  requirePermission(ctx, 'treasury.create');
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase.rpc('retail_shipment_pay', {
    p_org: ctx.organizationId,
    p_branch: ctx.branchId,
    p_shipment: shipmentId,
    p_account: null,
  });
  if (error) throw new AppError('validation', error.message);
  return Number(data ?? 0);
}

/**
 * Ask the carrier where a parcel is, and record only a real change.
 *
 * Returns the reported status, or null when the carrier had nothing to say —
 * which for a manual carrier is always, and must never be read as progress.
 */
export async function refreshTracking(
  ctx: TenantContext,
  shipment: Shipment,
): Promise<ShipmentStatus | null> {
  requirePermission(ctx, 'retail.order.manage');
  if (!shipment.trackingCode) return null;

  const update = await getCarrier(shipment.providerKey).track(shipment.trackingCode).catch(() => null);
  if (!update || update.status === shipment.status || update.status === 'pending') return null;

  await setShipmentStatus(
    ctx,
    shipment.id,
    update.status as 'dispatched' | 'delivered' | 'failed',
    update.reason ?? undefined,
  );
  return update.status;
}
