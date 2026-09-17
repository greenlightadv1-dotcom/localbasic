import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/action';
import { AppError } from '@/lib/errors';
import {
  checkoutInput, orderToken, quoteInput, storefrontInput,
  type CheckoutInput, type QuoteInput,
} from './schemas';

/**
 * The retail storefront, for guests.
 *
 * Every call here is anonymous by design, so the choke point is:
 *   rate limit → Zod validation → one narrow SECURITY DEFINER RPC.
 *
 * There is no tenant context because there is no session. The organization and
 * branch are resolved inside the database from the storefront slugs, which is
 * also where the store switch is checked and where ownership between the two
 * is proved. Nothing in this file trusts a price, and nothing accepts an
 * organization id.
 */

function guard(bucket: string, rule: { limit: number; windowMs: number }) {
  const ip = getClientIp();
  if (!checkRateLimit(`${bucket}:${ip}`, rule).ok) {
    throw new AppError('rate_limited');
  }
}

function rows<T>(data: unknown): T[] {
  return (Array.isArray(data) ? data : data == null ? [] : [data]) as T[];
}

export type StoreContext = {
  organizationId: string;
  branchId: string;
  branchSlug: string;
  name: string;
  currency: string;
  pickup: boolean;
  delivery: boolean;
  deliveryFeeCents: number;
  minOrderCents: number;
};

export type CatalogItem = {
  variantId: string;
  productId: string;
  productName: string;
  variantName: string;
  description: string | null;
  imageUrl: string | null;
  category: string | null;
  priceCents: number;
  taxRateBp: number;
  inStock: boolean;
  quantity: number;
};

export type CartQuote = {
  subtotalCents: number;
  taxCents: number;
  feeCents: number;
  totalCents: number;
  currency: string;
  minOrderCents: number;
};

export type PlacedOrder = {
  orderId: string;
  number: string;
  token: string;
  totalCents: number;
};

export type GuestOrder = {
  number: string;
  status: string;
  fulfillment: string;
  totalCents: number;
  currency: string;
  placedAt: string;
  paymentMethod: string;
  organizationName: string;
  lines: {
    productName: string;
    variantName: string;
    quantity: number;
    unitPriceCents: number;
    lineTotalCents: number;
  }[];
};

/** The shop, or null when its store is closed — the two are the same answer. */
export async function getStoreContext(input: unknown): Promise<StoreContext | null> {
  const parsed = storefrontInput.safeParse(input);
  if (!parsed.success) return null;
  guard('store-context', RATE_LIMITS.publicLinkResolve);

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('retail_store_context', {
    p_org_slug: parsed.data.orgSlug,
    p_branch_slug: parsed.data.branchSlug ?? null,
  });
  if (error) return null;

  type Row = {
    out_organization_id: string; out_branch_id: string; out_branch_slug: string;
    out_name: string; out_currency: string; out_pickup: boolean;
    out_delivery: boolean; out_delivery_fee: number; out_min_order: number;
  };
  const row = rows<Row>(data)[0];
  if (!row?.out_organization_id) return null;

  return {
    organizationId: row.out_organization_id,
    branchId: row.out_branch_id,
    branchSlug: row.out_branch_slug,
    name: row.out_name,
    currency: row.out_currency,
    pickup: Boolean(row.out_pickup),
    delivery: Boolean(row.out_delivery),
    deliveryFeeCents: Number(row.out_delivery_fee),
    minOrderCents: Number(row.out_min_order),
  };
}

export async function getStoreCatalog(
  orgSlug: string,
  branchSlug?: string,
  search?: string,
): Promise<CatalogItem[]> {
  guard('store-catalog', RATE_LIMITS.publicLinkResolve);
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase.rpc('retail_store_catalog', {
    p_org_slug: orgSlug,
    p_branch_slug: branchSlug ?? null,
    p_search: search ?? null,
  });
  if (error) return [];

  type Row = {
    out_variant_id: string; out_product_id: string; out_product_name: string;
    out_variant_name: string; out_description: string | null;
    out_image_url: string | null; out_category: string | null;
    out_price_cents: number; out_tax_rate_bp: number;
    out_in_stock: boolean; out_quantity: number;
  };
  return rows<Row>(data).map((r) => ({
    variantId: r.out_variant_id,
    productId: r.out_product_id,
    productName: r.out_product_name,
    variantName: r.out_variant_name,
    description: r.out_description,
    imageUrl: r.out_image_url,
    category: r.out_category,
    priceCents: Number(r.out_price_cents),
    taxRateBp: Number(r.out_tax_rate_bp),
    inStock: Boolean(r.out_in_stock),
    quantity: Number(r.out_quantity),
  }));
}

/**
 * What this basket costs.
 *
 * The same arithmetic the order will use, so the number shown before the
 * customer commits is the number they are charged.
 */
export async function quoteCart(input: QuoteInput): Promise<CartQuote | null> {
  guard('store-quote', RATE_LIMITS.publicLinkResolve);
  const parsed = quoteInput.safeParse(input);
  if (!parsed.success) return null;

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('retail_price_cart', {
    p_org_slug: parsed.data.orgSlug,
    p_branch_slug: parsed.data.branchSlug,
    p_items: parsed.data.items.map((i) => ({
      variant_id: i.variantId,
      quantity: i.quantity,
    })),
    p_fulfillment: parsed.data.fulfillment,
  });
  if (error) return null;

  type Row = {
    out_subtotal_cents: number; out_tax_cents: number; out_fee_cents: number;
    out_total_cents: number; out_currency: string; out_min_order: number;
  };
  const row = rows<Row>(data)[0];
  if (!row) return null;

  return {
    subtotalCents: Number(row.out_subtotal_cents),
    taxCents: Number(row.out_tax_cents),
    feeCents: Number(row.out_fee_cents),
    totalCents: Number(row.out_total_cents),
    currency: row.out_currency,
    minOrderCents: Number(row.out_min_order),
  };
}

/**
 * Place the order.
 *
 * The one write an anonymous visitor makes. Tighter rate limit than the reads,
 * because this one commits stock.
 */
export async function placeOrder(input: CheckoutInput): Promise<PlacedOrder> {
  guard('store-checkout', RATE_LIMITS.storeCheckout);
  const parsed = checkoutInput.safeParse(input);
  if (!parsed.success) {
    throw new AppError('validation', parsed.error.issues[0]?.message ?? 'بيانات غير صالحة');
  }
  const v = parsed.data;

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('retail_place_order', {
    p_org_slug: v.orgSlug,
    p_branch_slug: v.branchSlug,
    p_items: v.items.map((i) => ({ variant_id: i.variantId, quantity: i.quantity })),
    p_fulfillment: v.fulfillment,
    p_contact_name: v.contactName,
    p_contact_phone: v.contactPhone,
    p_payment_method: v.paymentMethod,
    p_note: v.note || null,
    p_idempotency_key: v.idempotencyKey,
    p_recipient_name: v.recipientName || null,
    p_address_phone: v.addressPhone || null,
    p_city: v.city || null,
    p_area: v.area || null,
    p_address_line: v.addressLine || null,
    p_landmark: v.landmark || null,
  });
  if (error) throw new AppError('validation', error.message);

  type Row = {
    out_order_id: string; out_number: string; out_token: string; out_total_cents: number;
  };
  const row = rows<Row>(data)[0];
  if (!row?.out_order_id) throw new AppError('validation', 'تعذّر إتمام الطلب');

  return {
    orderId: row.out_order_id,
    number: row.out_number,
    token: row.out_token,
    totalCents: Number(row.out_total_cents),
  };
}

/** One order, by its token. Nothing else is reachable with it. */
export async function getGuestOrder(token: unknown): Promise<GuestOrder | null> {
  const parsed = orderToken.safeParse(token);
  if (!parsed.success) return null;
  guard('store-track', RATE_LIMITS.publicLinkResolve);

  const supabase = createSupabaseServerClient();
  const [{ data: head, error }, { data: lines }] = await Promise.all([
    supabase.rpc('retail_order_status', { p_token: parsed.data }),
    supabase.rpc('retail_order_lines', { p_token: parsed.data }),
  ]);
  if (error) return null;

  type Head = {
    out_number: string; out_status: string; out_fulfillment: string;
    out_total_cents: number; out_currency: string; out_placed_at: string;
    out_payment_method: string; out_organization: string;
  };
  type Line = {
    out_product_name: string; out_variant_name: string; out_quantity: number;
    out_unit_price_cents: number; out_line_total_cents: number;
  };

  const row = rows<Head>(head)[0];
  if (!row?.out_number) return null;

  return {
    number: row.out_number,
    status: row.out_status,
    fulfillment: row.out_fulfillment,
    totalCents: Number(row.out_total_cents),
    currency: row.out_currency,
    placedAt: row.out_placed_at,
    paymentMethod: row.out_payment_method,
    organizationName: row.out_organization,
    lines: rows<Line>(lines).map((l) => ({
      productName: l.out_product_name,
      variantName: l.out_variant_name,
      quantity: Number(l.out_quantity),
      unitPriceCents: Number(l.out_unit_price_cents),
      lineTotalCents: Number(l.out_line_total_cents),
    })),
  };
}
