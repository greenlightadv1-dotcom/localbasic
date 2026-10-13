import 'server-only';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { toAppError } from '@/lib/errors';
import { requirePermission, type TenantContext } from '@/modules/core/tenancy/context';

// Re-exported so existing callers keep working. The implementation moved to
// lib/color.ts because this module is server-only and the helper is not.
export { hexToRgbChannels } from '@/lib/color';

export type Branding = {
  displayName: string;
  logoUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  /** Whether the "Powered by LocalBasic" footer may be hidden. Resolved from
   *  the organization's plan, never from a client-supplied flag. */
  whiteLabel: boolean;
  /**
   * Whether the plan lets this store use its own colors (Growth/Scale). When
   * false, `primaryColor`/`secondaryColor` above are the LocalBasic defaults
   * — the EFFECTIVE colors every screen should render — while the store's
   * saved choice is kept in `storedPrimaryColor`/`storedSecondaryColor` so an
   * upgrade brings it straight back and the settings page can show it locked.
   */
  customColors: boolean;
  storedPrimaryColor: string;
  storedSecondaryColor: string;
};

const DEFAULTS: Omit<Branding, 'displayName'> = {
  logoUrl: null,
  primaryColor: '#1E2FC8',
  secondaryColor: '#6B8BFA',
  phone: null,
  whatsapp: null,
  email: null,
  whiteLabel: false,
  customColors: false,
  storedPrimaryColor: '#1E2FC8',
  storedSecondaryColor: '#6B8BFA',
};

export async function getBranding(ctx: TenantContext): Promise<Branding> {
  const supabase = createSupabaseServerClient();

  const [{ data: branding }, { data: subscription }] = await Promise.all([
    supabase
      .from('branding_settings')
      .select('display_name, logo_url, primary_color, secondary_color, phone, whatsapp, email, white_label')
      .eq('organization_id', ctx.organizationId)
      .maybeSingle(),
    supabase
      .from('subscriptions')
      .select('status, plans!inner(features)')
      .eq('organization_id', ctx.organizationId)
      .in('status', ['trialing', 'active', 'past_due'])
      .maybeSingle(),
  ]);

  // White-label is granted by the plan. The branding row's own flag is only
  // honoured when the plan actually includes the feature, so downgrading a
  // subscription silently restores the platform footer.
  const features = (subscription?.plans as unknown as { features: Record<string, unknown> } | null)
    ?.features;
  const planAllowsWhiteLabel = features?.white_label === true;
  // Own colors are a plan feature too. Mirrors app.effective_brand_color()
  // (0091), which the public pages read through — one rule in two places, so a
  // Basic store sees the LocalBasic palette in its dashboard as well as to
  // its guests.
  const customColors = features?.custom_colors === true;
  const storedPrimary = branding?.primary_color ?? DEFAULTS.primaryColor;
  const storedSecondary = branding?.secondary_color ?? DEFAULTS.secondaryColor;

  return {
    displayName: branding?.display_name ?? ctx.organizationName,
    logoUrl: branding?.logo_url ?? DEFAULTS.logoUrl,
    primaryColor: customColors ? storedPrimary : DEFAULTS.primaryColor,
    secondaryColor: customColors ? storedSecondary : DEFAULTS.secondaryColor,
    customColors,
    storedPrimaryColor: storedPrimary,
    storedSecondaryColor: storedSecondary,
    phone: branding?.phone ?? null,
    whatsapp: branding?.whatsapp ?? null,
    email: branding?.email ?? null,
    whiteLabel: planAllowsWhiteLabel && branding?.white_label === true,
  };
}

const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'لون غير صالح');

export const updateBrandingSchema = z.object({
  displayName: z.string().trim().min(1, 'الاسم مطلوب').max(120),
  logoUrl: z.string().trim().url().max(2000).nullable(),
  primaryColor: hexColor,
  secondaryColor: hexColor,
  phone: z.string().trim().max(40).nullable(),
  whatsapp: z.string().trim().max(40).nullable(),
  email: z.string().trim().email('بريد غير صحيح').max(160).nullable().or(z.literal('')),
});

export type UpdateBrandingInput = z.infer<typeof updateBrandingSchema>;

/**
 * The row every organization already has, from the moment it was
 * provisioned (0009/0024 insert one at the same time as the workspace
 * itself). An UPDATE is therefore always the right verb here — there is no
 * "first time" case needing an INSERT, and branding_settings' own RLS
 * policy (0007) only ever grants UPDATE, never INSERT, to a tenant session.
 */
export async function updateBranding(
  ctx: TenantContext,
  input: UpdateBrandingInput,
): Promise<void> {
  requirePermission(ctx, 'branding.manage');
  const supabase = createSupabaseServerClient();

  // A plan without custom colors cannot change them, whatever the form sent:
  // the saved colors are left exactly as they were (so an upgrade restores
  // them) and everything else still saves.
  const { customColors } = await getBranding(ctx);

  const { error } = await supabase
    .from('branding_settings')
    .update({
      display_name: input.displayName,
      logo_url: input.logoUrl,
      ...(customColors
        ? { primary_color: input.primaryColor, secondary_color: input.secondaryColor }
        : {}),
      phone: input.phone || null,
      whatsapp: input.whatsapp || null,
      email: input.email || null,
    })
    .eq('organization_id', ctx.organizationId);

  if (error) throw toAppError(error, 'updateBranding');
}
