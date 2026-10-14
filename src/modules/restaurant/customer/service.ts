import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { toAppError } from '@/lib/errors';
import type { CustomerProfile, ProfileScope } from './types';

type Raw = {
  verified: boolean;
  name?: string | null;
  phone?: string;
  currency?: string;
  addresses?: {
    recipient_name: string; phone: string; city: string | null; area: string | null;
    address: string; landmark: string | null;
  }[];
  orders?: {
    number: string; status: string; type: string; total_cents: number; placed_at: string; token: string | null;
    items: {
      variant_id: string | null; product_name: string; variant_name: string;
      quantity: number | string; note: string | null; modifier_ids: string[];
    }[];
  }[];
  loyalty?: {
    enabled: boolean; earned: number; spent: number; balance: number;
    reward_points: number; reward_value_cents: number; cents_per_point: number;
  };
  coupons?: { code: string; value_cents: number; expires_at: string }[];
};

/**
 * A returning guest's profile. Identity is a device verified over WhatsApp for
 * this phone (restaurant_guest_devices); anything else comes back as
 * `{ verified: false }` with no data, so a typed phone number alone reveals
 * nothing. Never throws for "not recognised".
 */
export async function getCustomerProfile(
  scope: ProfileScope,
  deviceId: string,
  phone: string,
): Promise<CustomerProfile> {
  const supabase = createSupabaseServerClient();
  const { data, error } =
    scope.kind === 'slug'
      ? await supabase.rpc('customer_profile', { p_org_slug: scope.orgSlug, p_device_id: deviceId, p_phone: phone })
      : await supabase.rpc('customer_profile_by_token', { p_token: scope.token, p_device_id: deviceId, p_phone: phone });
  if (error) throw toAppError(error, 'getCustomerProfile');

  const raw = data as unknown as Raw | null;
  if (!raw?.verified) return { verified: false };

  const loyalty = raw.loyalty;
  return {
    verified: true,
    name: raw.name ?? null,
    phone: raw.phone ?? phone,
    currency: raw.currency ?? 'EGP',
    addresses: (raw.addresses ?? []).map((a) => ({
      recipientName: a.recipient_name, phone: a.phone, city: a.city, area: a.area,
      address: a.address, landmark: a.landmark,
    })),
    orders: (raw.orders ?? []).map((o) => ({
      number: o.number, status: o.status, type: o.type, totalCents: Number(o.total_cents),
      placedAt: o.placed_at, token: o.token,
      items: o.items
        .filter((i) => i.variant_id)
        .map((i) => ({
          variantId: i.variant_id as string,
          productName: i.product_name,
          variantName: i.variant_name,
          quantity: Math.max(1, Math.round(Number(i.quantity))),
          note: i.note,
          modifierIds: i.modifier_ids ?? [],
        })),
    })),
    loyalty: {
      enabled: loyalty?.enabled ?? false,
      earned: loyalty?.earned ?? 0,
      spent: loyalty?.spent ?? 0,
      balance: loyalty?.balance ?? 0,
      rewardPoints: loyalty?.reward_points ?? 100,
      rewardValueCents: Number(loyalty?.reward_value_cents ?? 2000),
      centsPerPoint: loyalty?.cents_per_point ?? 1000,
    },
    coupons: (raw.coupons ?? []).map((c) => ({
      code: c.code, valueCents: Number(c.value_cents), expiresAt: c.expires_at,
    })),
  };
}

/** Spends points on one reward coupon. The database re-checks everything. */
export async function claimReward(
  scope: ProfileScope,
  deviceId: string,
  phone: string,
): Promise<{ code: string; valueCents: number; expiresAt: string }> {
  const supabase = createSupabaseServerClient();
  const { data, error } =
    scope.kind === 'slug'
      ? await supabase.rpc('customer_claim_reward', { p_org_slug: scope.orgSlug, p_device_id: deviceId, p_phone: phone })
      : await supabase.rpc('customer_claim_reward_by_token', { p_token: scope.token, p_device_id: deviceId, p_phone: phone });
  if (error) throw toAppError(error, 'claimReward');
  const row = data as unknown as { code: string; value_cents: number; expires_at: string } | null;
  if (!row) throw toAppError(new Error('empty claim'), 'claimReward');
  return { code: row.code, valueCents: Number(row.value_cents), expiresAt: row.expires_at };
}

/**
 * The store's loyalty rules, readable before a guest is recognised. Null when
 * the program is off or the lookup fails — the cart bar then simply shows no
 * loyalty line.
 */
export async function getPublicLoyalty(scope: ProfileScope): Promise<{
  enabled: true; centsPerPoint: number; rewardPoints: number; rewardValueCents: number;
} | null> {
  const supabase = createSupabaseServerClient();
  const { data, error } =
    scope.kind === 'slug'
      ? await supabase.rpc('loyalty_public_info', { p_org_slug: scope.orgSlug })
      : await supabase.rpc('loyalty_public_info_by_token', { p_token: scope.token });
  if (error) return null;
  const row = (Array.isArray(data) ? data[0] : data) as
    | { out_cents_per_point: number; out_reward_points: number; out_reward_value_cents: number }
    | undefined;
  if (!row) return null;
  return {
    enabled: true,
    centsPerPoint: row.out_cents_per_point,
    rewardPoints: row.out_reward_points,
    rewardValueCents: Number(row.out_reward_value_cents),
  };
}
