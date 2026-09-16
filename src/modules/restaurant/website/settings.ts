import 'server-only';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requirePermission, type TenantContext } from '@/modules/core/tenancy/context';
import { AppError } from '@/lib/errors';
import type { OpeningDay } from './shared';
import type { Json } from '@/types/database';

/**
 * Owner-facing website configuration.
 *
 * Stored in public.settings at organization scope — a restaurant has one
 * website, not one per branch — and validated again by the database trigger, so
 * these shapes hold whatever path writes them. Changes are audited by the same
 * trigger that audits the D1.1 ordering settings.
 *
 * This is deliberately not a website builder: four fields and opening hours.
 * No custom HTML, no custom CSS, no tenant JavaScript.
 */

export const WEBSITE_SETTING_KEYS = {
  enabled: 'restaurant.website_enabled',
  tagline: 'restaurant.website_tagline',
  about: 'restaurant.website_about',
  hero: 'restaurant.website_hero_url',
  hours: 'restaurant.opening_hours',
} as const;

export type WebsiteSettings = {
  enabled: boolean;
  tagline: string;
  about: string;
  heroUrl: string;
  hours: OpeningDay[];
};

const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export const DEFAULT_HOURS: OpeningDay[] = Array.from({ length: 7 }, () => ({
  closed: false,
  opens: '12:00',
  closes: '23:00',
}));

export const websiteSettingsInput = z.object({
  enabled: z.coerce.boolean(),
  tagline: z.string().trim().max(200).default(''),
  about: z.string().trim().max(2000).default(''),
  // https only, matching the database CHECK. An empty value clears it.
  heroUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === '' || /^https:\/\/[^\s<>"]+$/.test(v), 'رابط الصورة يجب أن يبدأ بـ https')
    .default(''),
  hours: z
    .array(
      z.object({
        closed: z.coerce.boolean(),
        opens: z.string().trim().default(''),
        closes: z.string().trim().default(''),
      }),
    )
    .length(7, 'مواعيد العمل تحتاج سبعة أيام'),
});

export async function getWebsiteSettings(ctx: TenantContext): Promise<WebsiteSettings> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('settings')
    .select('key, value')
    .eq('organization_id', ctx.organizationId)
    .is('branch_id', null)
    .in('key', Object.values(WEBSITE_SETTING_KEYS));
  if (error) throw error;

  const byKey = new Map((data ?? []).map((r) => [r.key, r.value]));
  const hours = byKey.get(WEBSITE_SETTING_KEYS.hours);

  return {
    enabled: byKey.get(WEBSITE_SETTING_KEYS.enabled) === true,
    tagline: String(byKey.get(WEBSITE_SETTING_KEYS.tagline) ?? ''),
    about: String(byKey.get(WEBSITE_SETTING_KEYS.about) ?? ''),
    heroUrl: String(byKey.get(WEBSITE_SETTING_KEYS.hero) ?? ''),
    hours: Array.isArray(hours) && hours.length === 7 ? (hours as OpeningDay[]) : DEFAULT_HOURS,
  };
}

export async function saveWebsiteSettings(ctx: TenantContext, input: unknown): Promise<void> {
  requirePermission(ctx, 'settings.manage');

  const parsed = websiteSettingsInput.safeParse(input);
  if (!parsed.success) {
    throw new AppError('validation', parsed.error.issues[0]?.message ?? 'بيانات غير صالحة');
  }
  const v = parsed.data;

  // Normalised before storing: a closed day carries no times, and an open day
  // must carry two valid ones. The database repeats this check.
  const hours: OpeningDay[] = v.hours.map((d) => {
    if (d.closed) return { closed: true };
    if (!TIME.test(d.opens) || !TIME.test(d.closes)) {
      throw new AppError('validation', 'مواعيد العمل يجب أن تكون بصيغة HH:MM');
    }
    return { closed: false, opens: d.opens, closes: d.closes };
  });

  const rows: { key: string; value: Json }[] = [
    { key: WEBSITE_SETTING_KEYS.enabled, value: v.enabled },
    { key: WEBSITE_SETTING_KEYS.tagline, value: v.tagline },
    { key: WEBSITE_SETTING_KEYS.about, value: v.about },
    { key: WEBSITE_SETTING_KEYS.hero, value: v.heroUrl },
    { key: WEBSITE_SETTING_KEYS.hours, value: hours as unknown as Json },
  ];

  const supabase = createSupabaseServerClient();
  for (const row of rows) {
    const { data: found } = await supabase
      .from('settings')
      .select('id')
      .eq('organization_id', ctx.organizationId)
      .is('branch_id', null)
      .eq('key', row.key)
      .maybeSingle();

    const { error } = found
      ? await supabase.from('settings').update({ value: row.value }).eq('id', found.id)
      : await supabase.from('settings').insert({
          organization_id: ctx.organizationId,
          branch_id: null,
          key: row.key,
          value: row.value,
        });
    if (error) throw new AppError('validation', error.message);
  }
}
