import 'server-only';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { staffDbError } from '@/lib/errors';
import type { TenantContext } from '@/modules/core/tenancy/context';

/** Call center (0106): find a caller by any phone format, save them, take their order. */

export type CallerAddress = {
  id: string | null; saved: boolean; customerId: string | null; label: string; recipientName: string | null; phone: string | null;
  city: string | null; area: string | null; address: string; landmark: string | null; isDefault: boolean;
};
export type CallerOrder = {
  id: string; number: string; placedAt: string; status: string; type: string; channel: string; totalCents: number;
  lines: { variantId: string | null; productName: string; variantName: string; quantity: number; note: string | null; modifierIds: string[] }[];
};
export type CallerLookup = {
  customers: { id: string; name: string; phone: string | null; notes: string | null }[];
  addresses: CallerAddress[];
  orders: CallerOrder[];
  points: number;
};

const phone = z.string().trim().min(7, 'رقم الهاتف غير مكتمل').max(30).regex(/^[0-9+ ()-]+$/, 'رقم الهاتف غير صالح');
export const lookupSchema = z.object({ phone });
export const customerSchema = z.object({ id: z.string().uuid().nullable(), name: z.string().trim().min(1, 'اسم العميل مطلوب').max(160), phone, notes: z.string().trim().max(1000).optional() });
export const addressSchema = z.object({
  customerId: z.string().uuid(), id: z.string().uuid().nullable(), label: z.string().trim().max(60).optional(),
  recipientName: z.string().trim().max(120).optional(), phone: z.string().trim().max(32).optional(),
  city: z.string().trim().max(120).optional(), area: z.string().trim().max(120).optional(),
  address: z.string().trim().min(5, 'العنوان قصير جدًا').max(500), landmark: z.string().trim().max(240).optional(),
  isDefault: z.boolean().default(false),
});
export const phoneOrderSchema = z.object({
  customerId: z.string().uuid(), type: z.enum(['delivery', 'pickup']),
  items: z.array(z.object({ variantId: z.string().uuid(), quantity: z.number().positive().max(999), note: z.string().trim().max(200).optional(), modifierIds: z.array(z.string().uuid()).max(30).optional() }))
    .min(1, 'أضف صنفًا واحدًا على الأقل').max(100),
  addressId: z.string().uuid().nullable().optional(),
  address: z.object({ address: z.string().trim().max(500), area: z.string().trim().max(120).optional(), city: z.string().trim().max(120).optional(), landmark: z.string().trim().max(240).optional(), notes: z.string().trim().max(500).optional() }).nullable().optional(),
  zoneId: z.string().uuid().nullable().optional(),
  note: z.string().trim().max(500).optional(),
  confirm: z.boolean().default(true),
});

async function call(fn: string, args: Record<string, unknown>, context: string): Promise<unknown> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc(fn as never, args as never);
  if (error) throw staffDbError(error, context);
  return data;
}

export async function lookupCaller(ctx: TenantContext, phoneNumber: string): Promise<CallerLookup> {
  const d = (await call('restaurant_callcenter_lookup', { p_org: ctx.organizationId, p_branch: ctx.branchId, p_phone: phoneNumber }, 'lookupCaller')) as Record<string, unknown>;
  const list = (k: string) => (d[k] ?? []) as Record<string, unknown>[];
  return {
    customers: list('customers').map((c) => ({ id: String(c.id), name: String(c.name), phone: (c.phone as string) ?? null, notes: (c.notes as string) ?? null })),
    addresses: list('addresses').map((a) => ({
      id: (a.id as string) ?? null, saved: Boolean(a.saved), customerId: (a.customer_id as string) ?? null, label: String(a.label ?? ''),
      recipientName: (a.recipient_name as string) ?? null, phone: (a.phone as string) ?? null, city: (a.city as string) ?? null,
      area: (a.area as string) ?? null, address: String(a.address), landmark: (a.landmark as string) ?? null, isDefault: Boolean(a.is_default),
    })),
    orders: list('orders').map((o) => ({
      id: String(o.id), number: String(o.number), placedAt: String(o.placed_at), status: String(o.status), type: String(o.type),
      channel: String(o.channel), totalCents: Number(o.total_cents),
      lines: ((o.lines ?? []) as Record<string, unknown>[]).map((l) => ({
        variantId: (l.variant_id as string) ?? null, productName: String(l.product_name), variantName: String(l.variant_name),
        quantity: Number(l.quantity), note: (l.note as string) ?? null, modifierIds: ((l.modifier_ids ?? []) as string[]),
      })),
    })),
    points: Number(d.points ?? 0),
  };
}

export const saveCustomer = (ctx: TenantContext, i: z.infer<typeof customerSchema>) =>
  call('restaurant_customer_upsert', { p_org: ctx.organizationId, p_branch: ctx.branchId, p_id: i.id, p_name: i.name, p_phone: i.phone, p_notes: i.notes ?? null }, 'saveCustomer') as Promise<string>;

export const saveAddress = (ctx: TenantContext, i: z.infer<typeof addressSchema>) =>
  call('restaurant_customer_address_save', {
    p_org: ctx.organizationId, p_branch: ctx.branchId, p_customer: i.customerId, p_id: i.id, p_label: i.label ?? null,
    p_recipient: i.recipientName ?? null, p_phone: i.phone ?? null, p_city: i.city ?? null, p_area: i.area ?? null,
    p_address: i.address, p_landmark: i.landmark ?? null, p_default: i.isDefault,
  }, 'saveAddress') as Promise<string>;

export async function placePhoneOrder(ctx: TenantContext, i: z.infer<typeof phoneOrderSchema>) {
  const data = await call('restaurant_callcenter_place_order', {
    p_org: ctx.organizationId, p_branch: ctx.branchId, p_customer: i.customerId, p_type: i.type,
    p_items: i.items.map((x) => ({ variant_id: x.variantId, quantity: x.quantity, note: x.note || undefined, modifier_ids: x.modifierIds ?? [] })),
    p_address: i.type === 'delivery' ? (i.addressId ? { id: i.addressId } : i.address ?? null) : null,
    p_zone: i.type === 'delivery' ? i.zoneId ?? null : null, p_note: i.note ?? null, p_confirm: i.confirm,
  }, 'placePhoneOrder');
  const row = (Array.isArray(data) ? data[0] : data) as { out_order_id: string; out_number: string; out_total_cents: number };
  return { orderId: row.out_order_id, number: row.out_number, totalCents: Number(row.out_total_cents) };
}
