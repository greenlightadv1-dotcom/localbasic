import 'server-only';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requirePermission, type TenantContext } from '@/modules/core/tenancy/context';
import { AppError } from '@/lib/errors';

/**
 * Where the branch is, for order-time geofencing (0081).
 *
 * Stored in public.settings under one key, 'restaurant.geofence', resolved
 * branch-then-organization exactly like the online ordering switches next to
 * it — no schema change to `branches` needed. A branch that never sets this
 * (lat is null) has geofencing skipped entirely, both here and in the
 * database functions that read it.
 */
const KEY = 'restaurant.geofence';

export type GeofenceSettings = {
  latitude: number | null;
  longitude: number | null;
  radiusM: number;
  overriddenAtBranch: boolean;
};

export const geofenceInput = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  // Mirrors the database default (app.restaurant_geofence) and the QR hard
  // stop's own multiplier — small enough to mean something, large enough to
  // survive ordinary GPS drift at a street-level location.
  radiusM: z.coerce.number().int().min(50).max(100_000),
});

export async function getGeofenceSettings(ctx: TenantContext): Promise<GeofenceSettings> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('settings')
    .select('branch_id, value')
    .eq('organization_id', ctx.organizationId)
    .eq('key', KEY);
  if (error) throw error;

  const rows = data ?? [];
  const branchRow = rows.find((r) => r.branch_id === ctx.branchId);
  const orgRow = rows.find((r) => r.branch_id === null);
  const row = branchRow ?? orgRow;
  const value = row?.value as { lat?: number; lng?: number; radiusM?: number } | undefined;

  return {
    latitude: value?.lat ?? null,
    longitude: value?.lng ?? null,
    radiusM: value?.radiusM ?? 300,
    overriddenAtBranch: Boolean(branchRow),
  };
}

export async function saveGeofenceSettings(
  ctx: TenantContext,
  input: unknown,
  scope: 'branch' | 'organization',
): Promise<void> {
  requirePermission(ctx, 'settings.manage');

  const parsed = geofenceInput.safeParse(input);
  if (!parsed.success) {
    throw new AppError('validation', parsed.error.issues[0]?.message ?? 'بيانات غير صالحة');
  }
  const v = parsed.data;
  const branchId = scope === 'branch' ? ctx.branchId : null;
  const value = { lat: v.latitude, lng: v.longitude, radiusM: v.radiusM };

  const supabase = createSupabaseServerClient();
  const base = supabase
    .from('settings')
    .select('id')
    .eq('organization_id', ctx.organizationId)
    .eq('key', KEY);
  const { data: found } = await (
    branchId === null ? base.is('branch_id', null) : base.eq('branch_id', branchId)
  ).maybeSingle();

  const { error } = found
    ? await supabase.from('settings').update({ value }).eq('id', found.id)
    : await supabase.from('settings').insert({
        organization_id: ctx.organizationId,
        branch_id: branchId,
        key: KEY,
        value,
      });

  if (error) throw new AppError('validation', error.message);
}
