import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AppError, notFound, toAppError } from '@/lib/errors';

/**
 * The guest-facing surface.
 *
 * Everything here runs with the anon key and an opaque token. No tenant
 * context, no session, no privileged client — the database functions return a
 * narrow projection and nothing else is reachable.
 */

export type PublicContext = {
  organizationName: string;
  branchName: string;
  tableName: string;
  currency: string;
  locale: string;
  logoUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
  whiteLabel: boolean;
  phone: string | null;
  whatsapp: string | null;
  orderingEnabled: boolean;
};

export type PublicModifier = { id: string; name: string; price_cents: number };
export type PublicModifierGroup = {
  id: string;
  name: string;
  min_select: number;
  max_select: number;
  modifiers: PublicModifier[];
};
export type PublicVariant = {
  id: string;
  name: string;
  price_cents: number;
  available: boolean;
};
export type PublicProduct = {
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  variants: PublicVariant[];
  modifier_groups: PublicModifierGroup[];
};
export type PublicCategory = {
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  products: PublicProduct[];
};

export async function getPublicContext(token: string): Promise<PublicContext> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .rpc('restaurant_public_context', { p_token: token })
    .maybeSingle();

  if (error) throw toAppError(error, 'getPublicContext');
  // An unknown, expired or revoked token is indistinguishable from one that
  // never existed.
  if (!data) throw notFound();

  const row = data as unknown as {
    organization_name: string;
    branch_name: string;
    table_name: string;
    currency: string;
    locale: string;
    logo_url: string | null;
    primary_color: string;
    secondary_color: string;
    white_label: boolean;
    phone: string | null;
    whatsapp: string | null;
    ordering_enabled: boolean;
  };

  return {
    organizationName: row.organization_name,
    branchName: row.branch_name,
    tableName: row.table_name,
    currency: row.currency,
    locale: row.locale,
    logoUrl: row.logo_url,
    primaryColor: row.primary_color,
    secondaryColor: row.secondary_color,
    whiteLabel: row.white_label,
    phone: row.phone,
    whatsapp: row.whatsapp,
    orderingEnabled: row.ordering_enabled,
  };
}

export async function getPublicMenu(token: string): Promise<PublicCategory[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('restaurant_public_menu', { p_token: token });
  if (error) throw toAppError(error, 'getPublicMenu');
  return (data as unknown as PublicCategory[]) ?? [];
}

export async function placePublicOrder(input: {
  token: string;
  items: { variantId: string; quantity: number; modifierIds: string[]; note?: string }[];
  guestName?: string;
  guestPhone?: string;
  note?: string;
}) {
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .rpc('restaurant_place_public_order', {
      p_token: input.token,
      p_items: input.items.map((i) => ({
        variant_id: i.variantId,
        quantity: i.quantity,
        modifier_ids: i.modifierIds,
        note: i.note ?? null,
      })),
      p_guest_name: input.guestName ?? null,
      p_guest_phone: input.guestPhone ?? null,
      p_note: input.note ?? null,
    })
    .single();

  if (error?.code === '23514' || error?.code === 'P0001') {
    throw new AppError('conflict', publicMessage(error.message));
  }
  if (error) throw toAppError(error, 'placePublicOrder');

  const row = data as unknown as {
    out_order_number: string;
    out_total_cents: number;
    out_status_token: string;
  } | null;
  if (!row) throw new AppError('internal');

  // The same opaque, single-purpose capability token online orders mint
  // (0037/0040/0076) — /order/track/[token] and its realtime status channel
  // resolve this exactly the way they already resolve an online order's.
  return {
    orderNumber: row.out_order_number,
    totalCents: row.out_total_cents,
    statusToken: row.out_status_token,
  };
}

export async function getPublicOrderStatus(token: string, orderNumber: string) {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .rpc('restaurant_public_order_status', { p_token: token, p_number: orderNumber })
    .maybeSingle();
  if (error) throw toAppError(error, 'getPublicOrderStatus');
  return (data as unknown as {
    number: string;
    status: string;
    total_cents: number;
    placed_at: string;
  } | null) ?? null;
}

function publicMessage(message: string): string {
  if (message.includes('no longer active')) return 'رمز QR لم يعد صالحًا. اطلب المساعدة من الكابتن.';
  if (message.includes('ordering from the QR code is disabled')) {
    return 'الطلب الذاتي غير مفعّل حاليًا. اطلب من الكابتن.';
  }
  if (message.includes('not available at this branch')) return 'أحد الأصناف غير متاح حاليًا.';
  if (message.includes('unknown or unavailable')) return 'أحد الأصناف لم يعد متاحًا.';
  if (message.includes('too many open orders')) return 'يوجد طلبات مفتوحة كثيرة على هذه الطاولة.';
  if (message.includes('invalid selection for group')) return 'أكمل الاختيارات المطلوبة.';
  return 'تعذّر إرسال الطلب. حاول مرة أخرى.';
}
