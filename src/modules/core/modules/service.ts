import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requirePermission, type TenantContext } from '@/modules/core/tenancy/context';
import { toAppError } from '@/lib/errors';
import type { Json } from '@/types/database';

export const RESTAURANT_FEATURE_KEYS = ['kitchen_display_enabled', 'captain_hall_enabled'] as const;
export type RestaurantFeatureKey = (typeof RESTAURANT_FEATURE_KEYS)[number];

/**
 * Scale a restaurant workspace up or down: turning Kitchen Display or
 * Captain/Hall off drops their nav links and pages (see app-shell.tsx and
 * each page's own guard) and the workspace runs as cashier-only. Turning
 * either back on needs no migration — the setting is read fresh on every
 * request, so it takes effect on next navigation.
 *
 * Stored in organization_modules.settings, the jsonb column that table has
 * carried since 0001 for exactly this — per-module operational settings —
 * rather than a new table for two booleans. RLS (0007) already grants
 * UPDATE on this table to 'organization.manage'; requirePermission() here
 * is the UI's own copy of that same check.
 */
export async function setRestaurantFeature(
  ctx: TenantContext,
  key: RestaurantFeatureKey,
  enabled: boolean,
): Promise<void> {
  requirePermission(ctx, 'organization.manage');
  const supabase = createSupabaseServerClient();

  const { data: row, error: readError } = await supabase
    .from('organization_modules')
    .select('settings')
    .eq('organization_id', ctx.organizationId)
    .eq('module_key', 'restaurant')
    .single();
  if (readError) throw toAppError(readError, 'setRestaurantFeature:read');

  const nextSettings = { ...((row?.settings as Record<string, unknown>) ?? {}), [key]: enabled };

  const { error } = await supabase
    .from('organization_modules')
    .update({ settings: nextSettings as Json })
    .eq('organization_id', ctx.organizationId)
    .eq('module_key', 'restaurant');
  if (error) throw toAppError(error, 'setRestaurantFeature:write');
}
