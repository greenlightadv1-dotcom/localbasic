import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { TenantContext } from '@/modules/core/tenancy/context';

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
};

const DEFAULTS: Omit<Branding, 'displayName'> = {
  logoUrl: null,
  primaryColor: '#1E2FC8',
  secondaryColor: '#6B8BFA',
  phone: null,
  whatsapp: null,
  email: null,
  whiteLabel: false,
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

  return {
    displayName: branding?.display_name ?? ctx.organizationName,
    logoUrl: branding?.logo_url ?? DEFAULTS.logoUrl,
    primaryColor: branding?.primary_color ?? DEFAULTS.primaryColor,
    secondaryColor: branding?.secondary_color ?? DEFAULTS.secondaryColor,
    phone: branding?.phone ?? null,
    whatsapp: branding?.whatsapp ?? null,
    email: branding?.email ?? null,
    whiteLabel: planAllowsWhiteLabel && branding?.white_label === true,
  };
}
