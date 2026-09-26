import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { checkRateLimit, RATE_LIMITS, type RateLimitRule } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/action';
import { AppError } from '@/lib/errors';
import {
  addressInput, addressRef, claimInput, favoriteInput, orderRef, orgSlug,
  profileInput, settingsInput,
} from './schemas';

export * from './shared';

/**
 * The customer account surface.
 *
 * Every function here is the same three steps: rate limit, validate, call one
 * narrow SECURITY DEFINER function. The database resolves the restaurant from
 * the slug and the customer from auth.uid(); this layer never passes an
 * organization id, a customer id or a user id, because it never learns one.
 *
 * Reads return empty rather than throwing when the caller is signed out or has
 * no customer row at this restaurant. That is deliberate: a signed-out visitor
 * poking at an account endpoint should get the same nothing as a signed-in one
 * with no history, so neither can be used to detect the other.
 */

function guard(bucket: string, rule: RateLimitRule) {
  if (!checkRateLimit(`${bucket}:${getClientIp()}`, rule).ok) {
    throw new AppError('rate_limited');
  }
}

function rows<T>(data: unknown): T[] {
  return (Array.isArray(data) ? data : data == null ? [] : [data]) as T[];
}

function first<T>(data: unknown): T | null {
  return rows<T>(data)[0] ?? null;
}

/** Is anybody signed in? The only question this layer asks about identity. */
export async function currentUser(): Promise<{ id: string; email: string | null } | null> {
  const supabase = createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}

export type CustomerProfile = {
  fullName: string;
  email: string | null;
  phone: string | null;
  locale: string;
  marketingOptIn: boolean;
  orderUpdatesOptIn: boolean;
  hasAccountHere: boolean;
};

export async function getProfile(slug: unknown): Promise<CustomerProfile | null> {
  const parsed = orgSlug.safeParse(slug);
  if (!parsed.success) return null;
  guard('account:profile', RATE_LIMITS.accountRead);

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('customer_account_profile', {
    p_org_slug: parsed.data,
  });
  if (error) return null;

  type Row = {
    full_name: string; email: string | null; phone: string | null; locale: string;
    marketing_opt_in: boolean; order_updates_opt_in: boolean; has_account_here: boolean;
  };
  const row = first<Row>(data);
  if (!row) return null;

  return {
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    locale: row.locale,
    marketingOptIn: Boolean(row.marketing_opt_in),
    orderUpdatesOptIn: Boolean(row.order_updates_opt_in),
    hasAccountHere: Boolean(row.has_account_here),
  };
}

export async function saveProfile(input: unknown): Promise<void> {
  const parsed = profileInput.safeParse(input);
  if (!parsed.success) {
    throw new AppError('validation', parsed.error.issues[0]?.message ?? 'تحقق من البيانات.');
  }
  guard('account:save-profile', RATE_LIMITS.accountWrite);

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('customer_account_save_profile', {
    p_org_slug: parsed.data.orgSlug,
    p_name: parsed.data.name,
    p_phone: parsed.data.phone || null,
    p_email: parsed.data.email || null,
  });
  if (error) throw new AppError('validation', error.message);
}

export async function saveSettings(input: unknown): Promise<void> {
  const parsed = settingsInput.safeParse(input);
  if (!parsed.success) throw new AppError('validation');
  guard('account:save-settings', RATE_LIMITS.accountWrite);

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('customer_account_save_settings', {
    p_org_slug: parsed.data.orgSlug,
    p_marketing: parsed.data.marketing,
    p_order_updates: parsed.data.orderUpdates,
  });
  if (error) throw new AppError('validation', error.message);
}

export type CustomerOrder = {
  number: string;
  status: string;
  type: string;
  channel: string;
  branchName: string;
  totalCents: number;
  currency: string;
  placedAt: string;
  itemCount: number;
};

export async function getOrders(slug: unknown): Promise<CustomerOrder[]> {
  const parsed = orgSlug.safeParse(slug);
  if (!parsed.success) return [];
  guard('account:orders', RATE_LIMITS.accountRead);

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('customer_orders', { p_org_slug: parsed.data });
  if (error) return [];

  type Row = {
    number: string; status: string; type: string; channel: string; branch_name: string;
    total_cents: number; currency: string; placed_at: string; item_count: number;
  };
  return rows<Row>(data).map((r) => ({
    number: r.number,
    status: r.status,
    type: r.type,
    channel: r.channel,
    branchName: r.branch_name,
    totalCents: Number(r.total_cents),
    currency: r.currency,
    placedAt: r.placed_at,
    itemCount: Number(r.item_count),
  }));
}

export type CustomerOrderDetail = {
  number: string;
  status: string;
  type: string;
  branchName: string;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  currency: string;
  placedAt: string;
  delivery: { address: string; city: string | null; area: string | null; landmark: string | null } | null;
  items: { productName: string; variantName: string; quantity: number; lineTotalCents: number }[];
};

export async function getOrderDetail(input: unknown): Promise<CustomerOrderDetail | null> {
  const parsed = orderRef.safeParse(input);
  if (!parsed.success) return null;
  guard('account:order-detail', RATE_LIMITS.accountRead);

  const supabase = createSupabaseServerClient();
  const [{ data, error }, { data: lines }] = await Promise.all([
    supabase.rpc('customer_order_detail', {
      p_org_slug: parsed.data.orgSlug,
      p_number: parsed.data.number,
    }),
    supabase.rpc('customer_order_items', {
      p_org_slug: parsed.data.orgSlug,
      p_number: parsed.data.number,
    }),
  ]);
  if (error) return null;

  type Row = {
    number: string; status: string; type: string; branch_name: string;
    subtotal_cents: number; discount_cents: number; tax_cents: number;
    delivery_fee_cents: number; total_cents: number; currency: string; placed_at: string;
    delivery_address: string | null; delivery_city: string | null;
    delivery_area: string | null; delivery_landmark: string | null;
  };
  const row = first<Row>(data);
  if (!row) return null;

  type LineRow = {
    product_name: string; variant_name: string; quantity: number; line_total_cents: number;
  };

  return {
    number: row.number,
    status: row.status,
    type: row.type,
    branchName: row.branch_name,
    subtotalCents: Number(row.subtotal_cents),
    discountCents: Number(row.discount_cents),
    taxCents: Number(row.tax_cents),
    deliveryFeeCents: Number(row.delivery_fee_cents),
    totalCents: Number(row.total_cents),
    currency: row.currency,
    placedAt: row.placed_at,
    delivery: row.delivery_address
      ? {
          address: row.delivery_address,
          city: row.delivery_city,
          area: row.delivery_area,
          landmark: row.delivery_landmark,
        }
      : null,
    items: rows<LineRow>(lines).map((l) => ({
      productName: l.product_name,
      variantName: l.variant_name,
      quantity: Number(l.quantity),
      lineTotalCents: Number(l.line_total_cents),
    })),
  };
}

export type FavoriteProduct = {
  productId: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  priceCents: number | null;
  currency: string;
  available: boolean;
};

export async function getFavorites(slug: unknown): Promise<FavoriteProduct[]> {
  const parsed = orgSlug.safeParse(slug);
  if (!parsed.success) return [];
  guard('account:favorites', RATE_LIMITS.accountRead);

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('customer_favorites', { p_org_slug: parsed.data });
  if (error) return [];

  type Row = {
    product_id: string; product_name: string; description: string | null;
    image_url: string | null; price_cents: number | null; currency: string; available: boolean;
  };
  return rows<Row>(data).map((r) => ({
    productId: r.product_id,
    name: r.product_name,
    description: r.description,
    imageUrl: r.image_url,
    priceCents: r.price_cents === null ? null : Number(r.price_cents),
    currency: r.currency,
    available: Boolean(r.available),
  }));
}

export async function addFavorite(input: unknown): Promise<void> {
  const parsed = favoriteInput.safeParse(input);
  if (!parsed.success) throw new AppError('validation', 'منتج غير صالح');
  guard('account:favorite-add', RATE_LIMITS.accountWrite);

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('customer_favorite_add', {
    p_org_slug: parsed.data.orgSlug,
    p_product_id: parsed.data.productId,
  });
  if (error) throw new AppError('validation', error.message);
}

export async function removeFavorite(input: unknown): Promise<void> {
  const parsed = favoriteInput.safeParse(input);
  if (!parsed.success) throw new AppError('validation', 'منتج غير صالح');
  guard('account:favorite-remove', RATE_LIMITS.accountWrite);

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('customer_favorite_remove', {
    p_org_slug: parsed.data.orgSlug,
    p_product_id: parsed.data.productId,
  });
  if (error) throw new AppError('validation', error.message);
}

export type SavedAddress = {
  id: string;
  label: string;
  recipientName: string | null;
  phone: string | null;
  city: string | null;
  area: string | null;
  address: string;
  landmark: string | null;
  isDefault: boolean;
};

export async function getAddresses(slug: unknown): Promise<SavedAddress[]> {
  const parsed = orgSlug.safeParse(slug);
  if (!parsed.success) return [];
  guard('account:addresses', RATE_LIMITS.accountRead);

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('customer_addresses_list', {
    p_org_slug: parsed.data,
  });
  if (error) return [];

  type Row = {
    id: string; label: string; recipient_name: string | null; phone: string | null;
    city: string | null; area: string | null; address: string;
    landmark: string | null; is_default: boolean;
  };
  return rows<Row>(data).map((r) => ({
    id: r.id,
    label: r.label,
    recipientName: r.recipient_name,
    phone: r.phone,
    city: r.city,
    area: r.area,
    address: r.address,
    landmark: r.landmark,
    isDefault: Boolean(r.is_default),
  }));
}

export async function saveAddress(input: unknown): Promise<void> {
  const parsed = addressInput.safeParse(input);
  if (!parsed.success) {
    throw new AppError('validation', parsed.error.issues[0]?.message ?? 'تحقق من البيانات.');
  }
  guard('account:address-save', RATE_LIMITS.accountWrite);
  const v = parsed.data;

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('customer_address_save', {
    p_org_slug: v.orgSlug,
    p_label: v.label,
    p_address: v.address,
    // An id from the form. The database uses it only as a filter against the
    // caller's own customer row, so one belonging to someone else edits
    // nothing rather than editing their address.
    p_id: v.id ?? null,
    p_recipient_name: v.recipientName || null,
    p_phone: v.phone || null,
    p_city: v.city || null,
    p_area: v.area || null,
    p_landmark: v.landmark || null,
    p_is_default: v.isDefault ?? false,
  });
  if (error) throw new AppError('validation', error.message);
}

export async function deleteAddress(input: unknown): Promise<void> {
  const parsed = addressRef.safeParse(input);
  if (!parsed.success) throw new AppError('validation');
  guard('account:address-delete', RATE_LIMITS.accountWrite);

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('customer_address_delete', {
    p_org_slug: parsed.data.orgSlug,
    p_id: parsed.data.id,
  });
  if (error) throw new AppError('validation', error.message);
}

/**
 * Attach an order placed as a guest to the account that just signed in.
 *
 * The authorisation is the order-status token and nothing else — see the long
 * note on `customer_claim_order` in migration 0040 for why that is the only
 * proof of ownership this system is willing to accept, and why a lookup by
 * order number or phone deliberately does not exist.
 */
export async function claimGuestOrder(input: unknown): Promise<{ number: string; orgSlug: string } | null> {
  const parsed = claimInput.safeParse(input);
  if (!parsed.success) return null;
  guard('account:claim', RATE_LIMITS.accountClaim);

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('customer_claim_order', {
    p_token: parsed.data.token,
  });
  if (error) return null;

  const row = first<{ out_number: string; out_org_slug: string }>(data);
  if (!row) return null;
  return { number: row.out_number, orgSlug: row.out_org_slug };
}
