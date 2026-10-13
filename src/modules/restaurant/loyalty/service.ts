import 'server-only';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { toAppError } from '@/lib/errors';
import { requirePermission, type TenantContext } from '@/modules/core/tenancy/context';

export type LoyaltySettings = {
  enabled: boolean;
  /** Money (in cents) a customer spends to earn one point. */
  centsPerPoint: number;
  rewardPoints: number;
  rewardValueCents: number;
  couponValidDays: number;
};

/** The form works in whole currency units; the database in cents. */
export const saveLoyaltySchema = z.object({
  enabled: z.boolean(),
  currencyPerPoint: z.coerce.number().min(0.01).max(100000),
  rewardPoints: z.coerce.number().int().min(1).max(1000000),
  rewardValue: z.coerce.number().min(0.01).max(1000000),
  couponValidDays: z.coerce.number().int().min(1).max(730),
});
export type SaveLoyaltyInput = z.infer<typeof saveLoyaltySchema>;

export async function getLoyaltySettings(ctx: TenantContext): Promise<LoyaltySettings> {
  requirePermission(ctx, 'settings.manage');
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('restaurant_loyalty_settings_get', { p_org: ctx.organizationId }).single();
  if (error) throw toAppError(error, 'getLoyaltySettings');
  const r = data as unknown as {
    out_enabled: boolean; out_cents_per_point: number; out_reward_points: number;
    out_reward_value_cents: number; out_coupon_valid_days: number;
  };
  return {
    enabled: r.out_enabled,
    centsPerPoint: r.out_cents_per_point,
    rewardPoints: r.out_reward_points,
    rewardValueCents: Number(r.out_reward_value_cents),
    couponValidDays: r.out_coupon_valid_days,
  };
}

export async function saveLoyaltySettings(ctx: TenantContext, input: SaveLoyaltyInput): Promise<void> {
  requirePermission(ctx, 'settings.manage');
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('restaurant_loyalty_settings_save', {
    p_org: ctx.organizationId,
    p_enabled: input.enabled,
    p_cents_per_point: Math.max(1, Math.round(input.currencyPerPoint * 100)),
    p_reward_points: input.rewardPoints,
    p_reward_value_cents: Math.max(1, Math.round(input.rewardValue * 100)),
    p_coupon_valid_days: input.couponValidDays,
  });
  if (error) throw toAppError(error, 'saveLoyaltySettings');
}
