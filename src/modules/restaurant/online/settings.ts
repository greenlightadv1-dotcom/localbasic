import 'server-only';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requirePermission, type TenantContext } from '@/modules/core/tenancy/context';
import { AppError } from '@/lib/errors';

/**
 * Online ordering settings.
 *
 * Stored in public.settings, which already scopes a key/value pair to an
 * organization or to one branch and already carries the right RLS — members
 * read, `settings.manage` writes. No second settings system.
 *
 * SCOPE: branch-level, falling back to the organization. A branch row wins
 * when present; otherwise the organization row is the default. That is the
 * rule app.restaurant_delivery_fee has used since D1, applied to the switches
 * too, so one branch can stop delivering without affecting the rest.
 */

export const ONLINE_SETTING_KEYS = {
  enabled: 'restaurant.online_ordering_enabled',
  pickup: 'restaurant.pickup_enabled',
  delivery: 'restaurant.delivery_enabled',
  fee: 'restaurant.delivery_fee_cents',
} as const;

/** Mirrors the database CHECK in migration 0038. */
export const MAX_DELIVERY_FEE_CENTS = 1_000_000;

export type OnlineSettings = {
  enabled: boolean;
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
  deliveryFeeCents: number;
  /** Which of the four are set on this branch rather than inherited. */
  overriddenAtBranch: Record<keyof typeof ONLINE_SETTING_KEYS, boolean>;
};

export const onlineSettingsInput = z.object({
  enabled: z.coerce.boolean(),
  pickupEnabled: z.coerce.boolean(),
  deliveryEnabled: z.coerce.boolean(),
  // Entered in whole currency units; converted to minor units here so the
  // database only ever sees an integer.
  deliveryFee: z.coerce
    .number()
    .min(0, 'الرسوم لا يمكن أن تكون سالبة')
    .max(MAX_DELIVERY_FEE_CENTS / 100, 'الرسوم أكبر من الحد المسموح'),
  /** Write to this branch only, or to the whole organization. */
  scope: z.enum(['branch', 'organization']),
});

const DEFAULTS = { enabled: false, pickup: true, delivery: true, fee: 0 };

export async function getOnlineSettings(ctx: TenantContext): Promise<OnlineSettings> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('settings')
    .select('branch_id, key, value')
    .eq('organization_id', ctx.organizationId)
    .in('key', Object.values(ONLINE_SETTING_KEYS));
  if (error) throw error;

  const rows = data ?? [];
  const at = (key: string, branchScoped: boolean) =>
    rows.find((r) => r.key === key && (branchScoped ? r.branch_id === ctx.branchId : r.branch_id === null));

  /** Branch value if present, else organization value, else the default. */
  function resolve<T>(key: string, fallback: T): T {
    const row = at(key, true) ?? at(key, false);
    return row ? (row.value as T) : fallback;
  }

  return {
    enabled: resolve(ONLINE_SETTING_KEYS.enabled, DEFAULTS.enabled),
    pickupEnabled: resolve(ONLINE_SETTING_KEYS.pickup, DEFAULTS.pickup),
    deliveryEnabled: resolve(ONLINE_SETTING_KEYS.delivery, DEFAULTS.delivery),
    deliveryFeeCents: Number(resolve(ONLINE_SETTING_KEYS.fee, DEFAULTS.fee)),
    overriddenAtBranch: {
      enabled: Boolean(at(ONLINE_SETTING_KEYS.enabled, true)),
      pickup: Boolean(at(ONLINE_SETTING_KEYS.pickup, true)),
      delivery: Boolean(at(ONLINE_SETTING_KEYS.delivery, true)),
      fee: Boolean(at(ONLINE_SETTING_KEYS.fee, true)),
    },
  };
}

/**
 * Save all four together.
 *
 * `settings.manage` is required, and RLS re-checks it on every row. The stored
 * shapes are validated again by a database trigger, so a value that reaches
 * the table through any other path is still a boolean or a bounded integer.
 * Changes are audited by that same trigger.
 */
export async function saveOnlineSettings(ctx: TenantContext, input: unknown): Promise<void> {
  requirePermission(ctx, 'settings.manage');

  const parsed = onlineSettingsInput.safeParse(input);
  if (!parsed.success) {
    throw new AppError('validation', parsed.error.issues[0]?.message ?? 'بيانات غير صالحة');
  }
  const v = parsed.data;
  const branchId = v.scope === 'branch' ? ctx.branchId : null;

  // Rounded once, here, so a fractional entry can never reach the column.
  const feeCents = Math.round(v.deliveryFee * 100);

  const supabase = createSupabaseServerClient();
  const rows = [
    { key: ONLINE_SETTING_KEYS.enabled, value: v.enabled },
    { key: ONLINE_SETTING_KEYS.pickup, value: v.pickupEnabled },
    { key: ONLINE_SETTING_KEYS.delivery, value: v.deliveryEnabled },
    { key: ONLINE_SETTING_KEYS.fee, value: feeCents },
  ];

  for (const row of rows) {
    // The unique index is over (organization, coalesce(branch, zero-uuid), key),
    // which PostgREST's onConflict cannot name, so each key is read then
    // written. `branch_id is null` and `branch_id = ?` need different filters.
    const base = supabase
      .from('settings')
      .select('id')
      .eq('organization_id', ctx.organizationId)
      .eq('key', row.key);

    const { data: found } = await (
      branchId === null ? base.is('branch_id', null) : base.eq('branch_id', branchId)
    ).maybeSingle();

    const { error } = found
      ? await supabase.from('settings').update({ value: row.value }).eq('id', found.id)
      : await supabase.from('settings').insert({
          organization_id: ctx.organizationId,
          branch_id: branchId,
          key: row.key,
          value: row.value,
        });

    if (error) throw new AppError('validation', error.message);
  }
}
