import 'server-only';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requirePlatformAdmin } from '@/modules/platform/admin/context';
import { AppError } from '@/lib/errors';

/**
 * The sellable service catalog.
 *
 * `organization_modules` records which verticals each organization has enabled;
 * this records which verticals the platform is willing to sell. Turning one off
 * gates NEW provisioning only — it never touches an organization already
 * running the service.
 */
export type PlatformService = {
  moduleKey: string;
  nameAr: string;
  nameEn: string;
  descriptionAr: string | null;
  isBuilt: boolean;
  isAvailable: boolean;
  sortOrder: number;
  /** How many organizations currently run it. */
  organizationCount: number;
};

export const setAvailabilityInput = z.object({
  moduleKey: z.string().trim().min(2).max(32),
  isAvailable: z.coerce.boolean(),
});

export async function listServices(): Promise<PlatformService[]> {
  await requirePlatformAdmin();
  const supabase = createSupabaseServerClient();

  const [{ data: services, error }, { data: modules }] = await Promise.all([
    supabase
      .from('platform_services')
      .select('module_key, name_ar, name_en, description_ar, is_built, is_available, sort_order')
      .order('sort_order'),
    supabase.from('organization_modules').select('module_key, enabled'),
  ]);
  if (error) throw error;

  const counts = new Map<string, number>();
  for (const m of modules ?? []) {
    if (m.enabled) counts.set(m.module_key, (counts.get(m.module_key) ?? 0) + 1);
  }

  return (services ?? []).map((s) => ({
    moduleKey: s.module_key,
    nameAr: s.name_ar,
    nameEn: s.name_en,
    descriptionAr: s.description_ar,
    isBuilt: s.is_built,
    isAvailable: s.is_available,
    sortOrder: s.sort_order,
    organizationCount: counts.get(s.module_key) ?? 0,
  }));
}

/** Services a new workspace may actually be provisioned with. */
export async function listAvailableServices(): Promise<PlatformService[]> {
  const all = await listServices();
  return all.filter((s) => s.isBuilt && s.isAvailable);
}

export async function setServiceAvailability(input: unknown): Promise<void> {
  await requirePlatformAdmin();
  const parsed = setAvailabilityInput.safeParse(input);
  if (!parsed.success) throw new AppError('validation', 'بيانات غير صالحة');

  const supabase = createSupabaseServerClient();

  // A service that does not exist yet can never be put on sale. The database
  // repeats this check when provisioning, so the UI cannot be the only guard.
  const { data: existing } = await supabase
    .from('platform_services')
    .select('is_built')
    .eq('module_key', parsed.data.moduleKey)
    .maybeSingle();
  if (!existing) throw new AppError('not_found');
  if (!existing.is_built && parsed.data.isAvailable) {
    throw new AppError('validation', 'لا يمكن إتاحة خدمة غير مبنية.');
  }

  const { error } = await supabase
    .from('platform_services')
    .update({ is_available: parsed.data.isAvailable })
    .eq('module_key', parsed.data.moduleKey);
  if (error) throw new AppError('validation', error.message);

  await supabase.rpc('write_platform_audit', {
    p_action: 'platform.service_availability_changed',
    p_entity_type: 'service',
    p_entity_id: parsed.data.moduleKey,
    p_after: { is_available: parsed.data.isAvailable },
  });
}
