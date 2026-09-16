import 'server-only';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requirePermission, type TenantContext } from '@/modules/core/tenancy/context';
import { AppError } from '@/lib/errors';
import type { Json } from '@/types/database';
import {
  BUTTON_STYLES, CONTAINER_WIDTHS, CTA_TARGETS, DEFAULT_THEME, SECTION_TYPES,
  THEME_BACKGROUNDS, THEME_FONTS, toSectionConfig, toTheme,
  type PublishedLayout, type SectionType, type Theme, type WebsiteSection,
} from './builder-shared';

export * from './builder-shared';

/**
 * The website builder.
 *
 * Draft sections live in restaurant_website_sections and the draft theme in
 * public.settings; publishing snapshots both into an append-only revision. The
 * public site reads only the live revision — see migration 0042.
 *
 * Nothing here accepts an organization id. The tenant comes from the context
 * the URL resolved, every write re-checks `settings.manage`, and RLS refuses
 * the row anyway if the check were ever skipped.
 *
 * Nothing here accepts HTML, CSS or JavaScript. The schemas below refuse angle
 * brackets outright and the database trigger refuses them again.
 */

const THEME_SETTING_KEY = 'restaurant.website_theme';

/** Plain text: bounded, and with no markup to become markup downstream. */
const plainText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `النص أطول من ${max} حرف`)
    .refine((v) => !/[<>]/.test(v), 'لا يمكن استخدام رموز HTML في المحتوى');

const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === '' || /^https:\/\/[^\s<>"]+$/.test(v), 'الرابط يجب أن يبدأ بـ https');

/**
 * Section content, per type.
 *
 * `.strict()` matters: an unknown key is an error rather than something
 * silently dropped, which is what stops a field being smuggled into the
 * published snapshot for some future renderer to pick up.
 */
const sectionConfigSchemas = {
  hero: z.object({
    title: plainText(200).optional(),
    subtitle: plainText(200).optional(),
    imageUrl: httpsUrl.optional(),
    buttonLabel: plainText(200).optional(),
    showOrderButton: z.coerce.boolean().optional(),
  }).strict(),
  about: z.object({
    title: plainText(200).optional(),
    body: plainText(4000).optional(),
    imageUrl: httpsUrl.optional(),
  }).strict(),
  menu: z.object({
    title: plainText(200).optional(),
    subtitle: plainText(200).optional(),
    showPrices: z.coerce.boolean().optional(),
  }).strict(),
  gallery: z.object({
    title: plainText(200).optional(),
    images: z.array(httpsUrl.refine((v) => v !== '', 'رابط الصورة مطلوب')).max(12).optional(),
  }).strict(),
  contact: z.object({
    title: plainText(200).optional(),
    subtitle: plainText(200).optional(),
    showPhone: z.coerce.boolean().optional(),
    showWhatsapp: z.coerce.boolean().optional(),
    showEmail: z.coerce.boolean().optional(),
  }).strict(),
  hours: z.object({ title: plainText(200).optional() }).strict(),
  branches: z.object({
    title: plainText(200).optional(),
    showAddresses: z.coerce.boolean().optional(),
  }).strict(),
  cta: z.object({
    title: plainText(200).optional(),
    subtitle: plainText(200).optional(),
    buttonLabel: plainText(200).optional(),
    // A choice, never a URL: an arbitrary target would make the site an open
    // redirect on the restaurant's own domain.
    buttonTarget: z.enum(CTA_TARGETS).optional(),
  }).strict(),
} as const;

export const sectionTypeInput = z.enum(SECTION_TYPES);

export const themeInput = z.object({
  primaryColor: z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/, 'لون غير صالح').or(z.literal('')),
  accentColor: z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/, 'لون غير صالح').or(z.literal('')),
  background: z.enum(THEME_BACKGROUNDS),
  font: z.enum(THEME_FONTS),
  buttonStyle: z.enum(BUTTON_STYLES),
  width: z.enum(CONTAINER_WIDTHS),
});

/** camelCase from the form → the snake_case shape the database validates. */
function toDbConfig(type: SectionType, input: unknown): Record<string, Json> {
  const parsed = sectionConfigSchemas[type].safeParse(input ?? {});
  if (!parsed.success) {
    throw new AppError('validation', parsed.error.issues[0]?.message ?? 'محتوى غير صالح');
  }
  const v = parsed.data as Record<string, unknown>;
  const out: Record<string, Json> = {};
  const map: Record<string, string> = {
    title: 'title', subtitle: 'subtitle', body: 'body',
    imageUrl: 'image_url', images: 'images',
    buttonLabel: 'button_label', buttonTarget: 'button_target',
    showPrices: 'show_prices', showPhone: 'show_phone', showWhatsapp: 'show_whatsapp',
    showEmail: 'show_email', showAddresses: 'show_addresses',
    showOrderButton: 'show_order_button',
  };
  for (const [key, value] of Object.entries(v)) {
    if (value === undefined) continue;
    // An empty string clears an optional field rather than storing "".
    if (typeof value === 'string' && value === '' && key !== 'title') continue;
    out[map[key] ?? key] = value as Json;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Draft reads
// ---------------------------------------------------------------------------

export async function listSections(ctx: TenantContext): Promise<WebsiteSection[]> {
  requirePermission(ctx, 'settings.manage');
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from('restaurant_website_sections')
    .select('id, section_type, sort_order, enabled, config')
    .eq('organization_id', ctx.organizationId)
    .order('sort_order')
    .order('id');
  if (error) throw error;

  return (data ?? []).map((r) => ({
    id: r.id,
    type: r.section_type as SectionType,
    sortOrder: r.sort_order,
    enabled: r.enabled,
    config: toSectionConfig(r.config),
  }));
}

export async function getTheme(ctx: TenantContext): Promise<Theme> {
  const supabase = createSupabaseServerClient();
  const { data } = await supabase
    .from('settings')
    .select('value')
    .eq('organization_id', ctx.organizationId)
    .is('branch_id', null)
    .eq('key', THEME_SETTING_KEY)
    .maybeSingle();
  return data ? toTheme(data.value) : DEFAULT_THEME;
}

export type PublishState = {
  /** The live revision's version, or null when nothing is published. */
  liveVersion: number | null;
  publishedAt: string | null;
  /** True when the draft has moved since the live revision was cut. */
  hasDraftChanges: boolean;
};

export async function getPublishState(ctx: TenantContext): Promise<PublishState> {
  requirePermission(ctx, 'settings.manage');
  const supabase = createSupabaseServerClient();

  const [{ data: live }, { data: sections }] = await Promise.all([
    supabase
      .from('restaurant_website_revisions')
      .select('version, published_at')
      .eq('organization_id', ctx.organizationId)
      .eq('is_live', true)
      .maybeSingle(),
    supabase
      .from('restaurant_website_sections')
      .select('updated_at')
      .eq('organization_id', ctx.organizationId)
      .order('updated_at', { ascending: false })
      .limit(1),
  ]);

  const newestDraft = sections?.[0]?.updated_at ?? null;
  return {
    liveVersion: live?.version ?? null,
    publishedAt: live?.published_at ?? null,
    hasDraftChanges: Boolean(
      newestDraft && (!live || new Date(newestDraft) > new Date(live.published_at)),
    ),
  };
}

// ---------------------------------------------------------------------------
// Draft writes
// ---------------------------------------------------------------------------

export async function addSection(ctx: TenantContext, type: unknown): Promise<void> {
  requirePermission(ctx, 'settings.manage');
  const parsed = sectionTypeInput.safeParse(type);
  if (!parsed.success) throw new AppError('validation', 'قسم غير معروف');

  const supabase = createSupabaseServerClient();
  const { data: last } = await supabase
    .from('restaurant_website_sections')
    .select('sort_order')
    .eq('organization_id', ctx.organizationId)
    .order('sort_order', { ascending: false })
    .limit(1);

  const { error } = await supabase.from('restaurant_website_sections').insert({
    organization_id: ctx.organizationId,
    section_type: parsed.data,
    sort_order: Math.min(999, (last?.[0]?.sort_order ?? -1) + 1),
    enabled: true,
    config: defaultConfigFor(parsed.data) as unknown as Json,
    created_by: ctx.userId,
  });
  // The unique index refuses a second MENU or HOURS section; say so plainly.
  if (error) {
    throw new AppError(
      'validation',
      error.code === '23505' ? 'هذا القسم مضاف بالفعل.' : error.message,
    );
  }
}

function defaultConfigFor(type: SectionType): Record<string, Json> {
  switch (type) {
    case 'hero': return { show_order_button: true };
    case 'menu': return { show_prices: true };
    case 'branches': return { show_addresses: true };
    case 'contact': return { show_phone: true, show_whatsapp: true, show_email: true };
    case 'cta': return { button_target: 'order' };
    default: return {};
  }
}

export async function updateSection(
  ctx: TenantContext,
  input: { id: string; type: unknown; enabled: boolean; config: unknown },
): Promise<void> {
  requirePermission(ctx, 'settings.manage');
  const id = z.string().uuid().safeParse(input.id);
  const type = sectionTypeInput.safeParse(input.type);
  if (!id.success || !type.success) throw new AppError('validation', 'قسم غير معروف');

  const supabase = createSupabaseServerClient();
  const { error } = await supabase
    .from('restaurant_website_sections')
    .update({
      enabled: input.enabled,
      config: toDbConfig(type.data, input.config) as unknown as Json,
    })
    // The id is a filter against this organization's own rows, never a claim:
    // one belonging to another restaurant matches nothing. RLS says the same.
    .eq('id', id.data)
    .eq('organization_id', ctx.organizationId);
  if (error) throw new AppError('validation', error.message);
}

export async function removeSection(ctx: TenantContext, sectionId: unknown): Promise<void> {
  requirePermission(ctx, 'settings.manage');
  const id = z.string().uuid().safeParse(sectionId);
  if (!id.success) throw new AppError('validation');

  const supabase = createSupabaseServerClient();
  const { error } = await supabase
    .from('restaurant_website_sections')
    .delete()
    .eq('id', id.data)
    .eq('organization_id', ctx.organizationId);
  if (error) throw new AppError('validation', error.message);
}

/**
 * Move one section up or down.
 *
 * Swapping the two rows' sort_order keeps the sequence dense and the operation
 * understandable — there is no renumbering pass to get half-applied.
 */
export async function moveSection(
  ctx: TenantContext,
  sectionId: unknown,
  direction: 'up' | 'down',
): Promise<void> {
  requirePermission(ctx, 'settings.manage');
  const id = z.string().uuid().safeParse(sectionId);
  if (!id.success) throw new AppError('validation');

  const sections = await listSections(ctx);
  const index = sections.findIndex((s) => s.id === id.data);
  if (index === -1) throw new AppError('not_found');

  const swapWith = direction === 'up' ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= sections.length) return;

  const a = sections[index]!;
  const b = sections[swapWith]!;
  const supabase = createSupabaseServerClient();

  // Positions are rewritten from the list's order rather than reusing the
  // stored numbers, so two sections that shared a sort_order still come apart.
  await supabase
    .from('restaurant_website_sections')
    .update({ sort_order: swapWith })
    .eq('id', a.id)
    .eq('organization_id', ctx.organizationId);
  await supabase
    .from('restaurant_website_sections')
    .update({ sort_order: index })
    .eq('id', b.id)
    .eq('organization_id', ctx.organizationId);
}

export async function saveTheme(ctx: TenantContext, input: unknown): Promise<void> {
  requirePermission(ctx, 'settings.manage');
  const parsed = themeInput.safeParse(input);
  if (!parsed.success) {
    throw new AppError('validation', parsed.error.issues[0]?.message ?? 'إعدادات غير صالحة');
  }
  const v = parsed.data;

  const value: Record<string, Json> = {
    background: v.background,
    font: v.font,
    button_style: v.buttonStyle,
    width: v.width,
  };
  if (v.primaryColor) value['primary_color'] = v.primaryColor;
  if (v.accentColor) value['accent_color'] = v.accentColor;

  const supabase = createSupabaseServerClient();
  const { data: found } = await supabase
    .from('settings')
    .select('id')
    .eq('organization_id', ctx.organizationId)
    .is('branch_id', null)
    .eq('key', THEME_SETTING_KEY)
    .maybeSingle();

  const { error } = found
    ? await supabase.from('settings').update({ value: value as unknown as Json }).eq('id', found.id)
    : await supabase.from('settings').insert({
        organization_id: ctx.organizationId,
        branch_id: null,
        key: THEME_SETTING_KEY,
        value: value as unknown as Json,
      });
  if (error) throw new AppError('validation', error.message);
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

/**
 * Make the draft public.
 *
 * The snapshot is assembled in the database from the draft rows — this layer
 * sends a slug and a note, never the content — so what goes live is what the
 * builder actually holds rather than what a form claimed it held.
 */
export async function publishWebsite(
  ctx: TenantContext,
  note?: string,
): Promise<{ version: number; sectionCount: number }> {
  requirePermission(ctx, 'settings.manage');

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('restaurant_website_publish', {
    p_org_slug: ctx.organizationSlug,
    p_note: note?.trim() || null,
  });
  if (error) throw new AppError('validation', error.message);

  const row = (Array.isArray(data) ? data[0] : data) as
    | { out_version: number; out_section_count: number }
    | undefined;
  if (!row) throw new AppError('validation', 'تعذّر نشر الموقع');
  return { version: Number(row.out_version), sectionCount: Number(row.out_section_count) };
}

export async function unpublishWebsite(ctx: TenantContext): Promise<void> {
  requirePermission(ctx, 'settings.manage');
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('restaurant_website_unpublish', {
    p_org_slug: ctx.organizationSlug,
  });
  if (error) throw new AppError('validation', error.message);
}

// ---------------------------------------------------------------------------
// Public read
// ---------------------------------------------------------------------------

/**
 * The published layout for a public visitor, or null.
 *
 * Null is the ordinary case for a restaurant that has never opened the
 * builder, and the site renders its default layout — which is why D2 keeps
 * working untouched.
 */
export async function getPublishedLayout(orgSlug: string): Promise<PublishedLayout | null> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('restaurant_website_layout', {
    p_org_slug: orgSlug,
  });
  if (error) return null;

  type Row = { version: number; sections: unknown; theme: unknown; published_at: string };
  const row = (Array.isArray(data) ? data[0] : data) as Row | undefined;
  if (!row || !Array.isArray(row.sections)) return null;

  const sections = (row.sections as Record<string, unknown>[])
    .filter((s) => (SECTION_TYPES as readonly string[]).includes(String(s['type'])))
    .map((s) => ({
      type: String(s['type']) as SectionType,
      config: toSectionConfig(s['config']),
    }));

  if (sections.length === 0) return null;

  return {
    version: Number(row.version),
    publishedAt: row.published_at,
    theme: toTheme(row.theme),
    sections,
  };
}
