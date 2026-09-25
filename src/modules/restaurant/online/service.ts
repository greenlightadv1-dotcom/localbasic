import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/action';
import { AppError } from '@/lib/errors';
import {
  quoteInput, checkoutInput, editInput, cancelInput, orderToken, storefront,
} from './schemas';

/**
 * Guest-facing online ordering.
 *
 * Every call here is anonymous by design, so the choke point is:
 *   rate limit → Zod validation → one narrow SECURITY DEFINER RPC.
 *
 * There is no tenant context because there is no session; the organization and
 * branch are resolved inside the database from the storefront slugs, which is
 * also where ownership between the two is proved. Nothing in this file trusts
 * a price, and nothing accepts an organization id.
 */

function guard(bucket: string, rule: { limit: number; windowMs: number }) {
  const ip = getClientIp();
  if (!checkRateLimit(`${bucket}:${ip}`, rule).ok) {
    throw new AppError('rate_limited');
  }
}

export type MenuItem = {
  categoryId: string | null;
  categoryName: string | null;
  productId: string;
  productName: string;
  description: string | null;
  imageUrl: string | null;
  variantId: string;
  variantName: string;
  priceCents: number;
};

export type ModifierGroup = {
  productId: string;
  groupId: string;
  groupName: string;
  minSelect: number;
  maxSelect: number;
  modifiers: { id: string; name: string; priceCents: number }[];
};

export type StorefrontInfo = {
  organizationName: string;
  branchName: string;
  currency: string;
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
  deliveryFeeCents: number;
  primaryColor: string;
  secondaryColor: string;
  logoUrl: string | null;
};

/**
 * What this storefront currently offers.
 *
 * Read from the database rather than assumed, so the page cannot render a
 * fulfilment button the checkout would refuse — and the delivery fee shown is
 * the one that will be charged.
 */
export async function getStorefront(input: unknown): Promise<StorefrontInfo | null> {
  const parsed = storefront.safeParse(input);
  if (!parsed.success) return null;

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('restaurant_online_storefront', {
    p_org_slug: parsed.data.orgSlug,
    p_branch_slug: parsed.data.branchSlug,
  });
  if (error) return null;

  type Row = {
    organization_name: string; branch_name: string; currency: string;
    pickup_enabled: boolean; delivery_enabled: boolean; delivery_fee_cents: number;
    primary_color: string; secondary_color: string; logo_url: string | null;
  };
  const row = (Array.isArray(data) ? data[0] : data) as Row | undefined;
  if (!row) return null;

  return {
    organizationName: row.organization_name,
    branchName: row.branch_name,
    currency: row.currency,
    pickupEnabled: row.pickup_enabled,
    deliveryEnabled: row.delivery_enabled,
    deliveryFeeCents: Number(row.delivery_fee_cents),
    primaryColor: row.primary_color,
    secondaryColor: row.secondary_color,
    logoUrl: row.logo_url,
  };
}

export async function getOnlineMenu(input: unknown) {
  const parsed = storefront.safeParse(input);
  if (!parsed.success) throw new AppError('validation');
  guard('online:menu', RATE_LIMITS.publicLinkResolve);

  const supabase = createSupabaseServerClient();
  const [{ data: rows, error }, { data: mods }] = await Promise.all([
    supabase.rpc('restaurant_online_menu', {
      p_org_slug: parsed.data.orgSlug,
      p_branch_slug: parsed.data.branchSlug,
    }),
    supabase.rpc('restaurant_online_modifiers', {
      p_org_slug: parsed.data.orgSlug,
      p_branch_slug: parsed.data.branchSlug,
    }),
  ]);
  if (error) throw new AppError('not_found');

  type MenuRow = {
    category_id: string | null; category_name: string | null;
    product_id: string; product_name: string; product_description: string | null;
    image_url: string | null; variant_id: string; variant_name: string;
    price_cents: number;
  };
  type ModRow = {
    product_id: string; group_id: string; group_name: string;
    min_select: number; max_select: number;
    modifier_id: string; modifier_name: string; price_cents: number;
  };

  const items: MenuItem[] = ((rows ?? []) as MenuRow[]).map((r) => ({
    categoryId: r.category_id,
    categoryName: r.category_name,
    productId: r.product_id,
    productName: r.product_name,
    description: r.product_description,
    imageUrl: r.image_url,
    variantId: r.variant_id,
    variantName: r.variant_name,
    priceCents: r.price_cents,
  }));

  const groups = new Map<string, ModifierGroup>();
  for (const m of (mods ?? []) as ModRow[]) {
    const g = groups.get(m.group_id) ?? {
      productId: m.product_id,
      groupId: m.group_id,
      groupName: m.group_name,
      minSelect: m.min_select,
      maxSelect: m.max_select,
      modifiers: [],
    };
    g.modifiers.push({ id: m.modifier_id, name: m.modifier_name, priceCents: m.price_cents });
    groups.set(m.group_id, g);
  }

  return { items, modifierGroups: [...groups.values()] };
}

export type Quote = {
  subtotalCents: number;
  taxCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  currency: string;
};

/**
 * Price a cart the guest is holding in their browser.
 *
 * The same validation and arithmetic the checkout performs, so what the cart
 * shows is what the order will cost — and a tampered cart is refused here
 * rather than at the till.
 */
export async function quoteCart(input: unknown): Promise<Quote> {
  const parsed = quoteInput.safeParse(input);
  if (!parsed.success) throw new AppError('validation', 'السلة غير صالحة');
  guard('online:quote', RATE_LIMITS.mutation);

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('restaurant_price_online_cart', {
    p_org_slug: parsed.data.orgSlug,
    p_branch_slug: parsed.data.branchSlug,
    p_items: toDbItems(parsed.data.items),
    p_fulfillment: parsed.data.fulfillment,
  });
  if (error) throw new AppError('validation', error.message);

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, number & string> | undefined;
  if (!row) throw new AppError('validation', 'تعذّر تسعير السلة');

  return {
    subtotalCents: Number(row.subtotal_cents),
    taxCents: Number(row.tax_cents),
    deliveryFeeCents: Number(row.delivery_fee_cents),
    totalCents: Number(row.total_cents),
    currency: String(row.currency),
  };
}

/** Shape the database's line builder expects. Ids and quantities only. */
function toDbItems(items: { variantId: string; quantity: number; modifierIds: string[]; note?: string }[]) {
  return items.map((i) => ({
    variant_id: i.variantId,
    quantity: i.quantity,
    modifier_ids: i.modifierIds,
    note: i.note || null,
  }));
}

export type PlacedOrder = {
  token: string;
  number: string;
  totalCents: number;
  editUntil: string;
};

export async function placeOnlineOrder(input: unknown): Promise<PlacedOrder> {
  const parsed = checkoutInput.safeParse(input);
  if (!parsed.success) {
    throw new AppError('validation', parsed.error.issues[0]?.message ?? 'بيانات غير صالحة');
  }
  guard('online:checkout', RATE_LIMITS.publicOrder);
  const v = parsed.data;

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('restaurant_place_online_order', {
    p_org_slug: v.orgSlug,
    p_branch_slug: v.branchSlug,
    p_items: toDbItems(v.items),
    p_fulfillment: v.fulfillment,
    p_customer_name: v.customerName,
    p_customer_phone: v.customerPhone,
    p_idempotency_key: v.idempotencyKey,
    p_address: v.address
      ? {
          recipient_name: v.address.recipientName || null,
          phone: v.address.phone || null,
          city: v.address.city || null,
          area: v.address.area || null,
          address: v.address.address,
          landmark: v.address.landmark || null,
          latitude: v.address.latitude ?? null,
          longitude: v.address.longitude ?? null,
          notes: v.address.notes || null,
        }
      : null,
    p_note: v.note || null,
    // D3. Null for a guest, and for an account that typed a fresh address.
    p_saved_address_id: v.savedAddressId ?? null,
  });
  if (error) throw new AppError('validation', error.message);

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, string> | undefined;
  if (!row) throw new AppError('validation', 'تعذّر إنشاء الطلب');

  return {
    token: row['out_token']!,
    number: row['out_number']!,
    totalCents: Number(row['out_total_cents']),
    editUntil: row['out_edit_until']!,
  };
}

export type OrderStatus = {
  number: string;
  status: string;
  type: string;
  subtotalCents: number;
  taxCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  currency: string;
  placedAt: string;
  canEdit: boolean;
  secondsLeft: number;
  items: { productName: string; variantName: string; quantity: number; lineTotalCents: number; note: string | null }[];
};

export async function getOrderByToken(token: unknown): Promise<OrderStatus | null> {
  const parsed = orderToken.safeParse(token);
  if (!parsed.success) return null;
  guard('online:status', RATE_LIMITS.publicLinkResolve);

  const supabase = createSupabaseServerClient();
  const [{ data, error }, { data: lines }] = await Promise.all([
    supabase.rpc('restaurant_online_order_status', { p_token: parsed.data }),
    supabase.rpc('restaurant_online_order_items', { p_token: parsed.data }),
  ]);
  if (error) return null;

  type StatusRow = {
    number: string; status: string; type: string;
    subtotal_cents: number; tax_cents: number; delivery_fee_cents: number;
    total_cents: number; currency: string; placed_at: string;
    can_edit: boolean; seconds_left: number;
  };
  const row = (Array.isArray(data) ? data[0] : data) as StatusRow | undefined;
  if (!row) return null;

  type LineRow = {
    product_name: string; variant_name: string; quantity: number;
    line_total_cents: number; note: string | null;
  };

  return {
    number: row.number,
    status: row.status,
    type: row.type,
    subtotalCents: Number(row.subtotal_cents),
    taxCents: Number(row.tax_cents),
    deliveryFeeCents: Number(row.delivery_fee_cents),
    totalCents: Number(row.total_cents),
    currency: row.currency,
    placedAt: row.placed_at,
    canEdit: Boolean(row.can_edit),
    secondsLeft: Number(row.seconds_left),
    items: ((lines ?? []) as LineRow[]).map((l) => ({
      productName: l.product_name,
      variantName: l.variant_name,
      quantity: Number(l.quantity),
      lineTotalCents: l.line_total_cents,
      note: l.note,
    })),
  };
}

/**
 * Edit inside the window.
 *
 * The deadline is not checked here — it is checked in the database, against
 * the server's own clock, on a timestamp written at creation and frozen by a
 * trigger. This layer would be the wrong place: a client-side timer decides
 * what to show, never what is allowed.
 */
export async function editOrder(input: unknown): Promise<{ number: string; totalCents: number }> {
  const parsed = editInput.safeParse(input);
  if (!parsed.success) throw new AppError('validation', 'بيانات غير صالحة');
  guard('online:edit', RATE_LIMITS.mutation);

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('restaurant_online_edit_order', {
    p_token: parsed.data.token,
    p_items: toDbItems(parsed.data.items),
  });
  if (error) throw new AppError('validation', error.message);

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, string> | undefined;
  if (!row) throw new AppError('validation', 'تعذّر تعديل الطلب');
  return { number: row['out_number']!, totalCents: Number(row['out_total_cents']) };
}

export async function cancelOrder(input: unknown): Promise<void> {
  const parsed = cancelInput.safeParse(input);
  if (!parsed.success) throw new AppError('validation', 'بيانات غير صالحة');
  guard('online:cancel', RATE_LIMITS.mutation);

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('restaurant_online_cancel_order', {
    p_token: parsed.data.token,
    p_reason: parsed.data.reason || null,
  });
  if (error) throw new AppError('validation', error.message);
}
