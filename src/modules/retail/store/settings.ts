import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AppError, toAppError } from '@/lib/errors';
import { requirePermission, type TenantContext } from '@/modules/core/tenancy/context';

/**
 * The shop's storefront settings.
 *
 * Read and written through `settings`, which already has RLS, an audit trigger
 * and — since 0046 — a validator deciding what each key may say. This layer
 * writes the branch row, so one branch can differ from the rest; an absent
 * branch row means "follow the organization".
 */

export const STORE_KEYS = {
  enabled: 'retail.store_enabled',
  pickup: 'retail.pickup_enabled',
  delivery: 'retail.delivery_enabled',
  deliveryFee: 'retail.delivery_fee_cents',
  minOrder: 'retail.min_order_cents',
} as const;

export type StoreSettings = {
  enabled: boolean;
  pickup: boolean;
  delivery: boolean;
  deliveryFeeCents: number;
  minOrderCents: number;
  /** Which values this branch has overridden, rather than inheriting. */
  overriddenAtBranch: Record<string, boolean>;
};

export async function getStoreSettings(ctx: TenantContext): Promise<StoreSettings> {
  requirePermission(ctx, 'settings.manage');
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from('settings')
    .select('key, value, branch_id')
    .eq('organization_id', ctx.organizationId)
    .in('key', Object.values(STORE_KEYS));

  if (error) throw toAppError(error, 'getStoreSettings');

  // Branch value wins, organization value is the default — the same precedence
  // the database readers use, so the screen cannot disagree with the store.
  const pick = (key: string) => {
    const branch = (data ?? []).find((r) => r.key === key && r.branch_id === ctx.branchId);
    const org = (data ?? []).find((r) => r.key === key && r.branch_id === null);
    return branch?.value ?? org?.value;
  };

  const bool = (key: string, fallback: boolean) => {
    const v = pick(key);
    return typeof v === 'boolean' ? v : fallback;
  };
  const int = (key: string, fallback: number) => {
    const v = pick(key);
    return typeof v === 'number' ? v : fallback;
  };

  return {
    enabled: bool(STORE_KEYS.enabled, false),
    pickup: bool(STORE_KEYS.pickup, true),
    delivery: bool(STORE_KEYS.delivery, true),
    deliveryFeeCents: int(STORE_KEYS.deliveryFee, 0),
    minOrderCents: int(STORE_KEYS.minOrder, 0),
    overriddenAtBranch: Object.fromEntries(
      Object.values(STORE_KEYS).map((key) => [
        key,
        (data ?? []).some((r) => r.key === key && r.branch_id === ctx.branchId),
      ]),
    ),
  };
}

export type StoreSettingsInput = {
  enabled: boolean;
  pickup: boolean;
  delivery: boolean;
  deliveryFeeCents: number;
  minOrderCents: number;
};

export async function saveStoreSettings(
  ctx: TenantContext,
  input: StoreSettingsInput,
): Promise<void> {
  requirePermission(ctx, 'settings.manage');

  // A store with no way to receive the goods is not open, it is a dead end.
  if (input.enabled && !input.pickup && !input.delivery) {
    throw new AppError('validation', 'فعّل الاستلام من الفرع أو التوصيل قبل فتح المتجر.');
  }

  const supabase = createSupabaseServerClient();
  const rows = [
    { key: STORE_KEYS.enabled, value: input.enabled },
    { key: STORE_KEYS.pickup, value: input.pickup },
    { key: STORE_KEYS.delivery, value: input.delivery },
    { key: STORE_KEYS.deliveryFee, value: Math.max(0, Math.round(input.deliveryFeeCents)) },
    { key: STORE_KEYS.minOrder, value: Math.max(0, Math.round(input.minOrderCents)) },
  ];

  for (const row of rows) {
    // The unique index is over (organization, coalesce(branch, zero-uuid), key),
    // which PostgREST's onConflict cannot name, so each key is read then
    // written — the same pattern the restaurant settings writer uses.
    const { data: found } = await supabase
      .from('settings')
      .select('id')
      .eq('organization_id', ctx.organizationId)
      .eq('branch_id', ctx.branchId)
      .eq('key', row.key)
      .maybeSingle();

    const { error } = found
      ? await supabase.from('settings').update({ value: row.value }).eq('id', found.id)
      : await supabase.from('settings').insert({
          organization_id: ctx.organizationId,
          branch_id: ctx.branchId,
          key: row.key,
          value: row.value,
        });

    if (error) throw new AppError('validation', error.message);
  }
}
