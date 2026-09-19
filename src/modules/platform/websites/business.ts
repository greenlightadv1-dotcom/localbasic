import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requirePlatformAdmin } from '@/modules/platform/admin/context';
import type { OrganizationBranding } from './theme';

/**
 * The adapter between LocalBasic Core and the website builder.
 *
 * The builder needs the customer's real business data — its name, its brand,
 * how to contact it, when it opens — as INPUT to a generated site. It must not
 * own a copy of any of it. A website that stored its own phone number would be
 * wrong the first time the customer changed theirs, and nobody would know
 * which of the two was the truth.
 *
 * So nothing here is a table the builder writes. Every field is read from
 * where Core already keeps it, through the platform projection in 0051 rather
 * than a direct read: branding_settings and settings are tenant tables with no
 * platform read policy, and they stay that way.
 */

export type OpeningHoursDay = { closed: boolean; opens?: string; closes?: string };

export type BusinessProfile = {
  organizationName: string;
  organizationSlug: string;
  primaryModule: string;
  currency: string;
  branding: OrganizationBranding;
  contact: { phone: string | null; whatsapp: string | null; email: string | null };
  openingHours: OpeningHoursDay[] | null;
  branchCount: number;
};

/**
 * Read a customer's business data as builder input.
 *
 * Returns null for an organization that does not exist, is soft-deleted, or
 * that the caller may not see — the same answer for all three, so an operator
 * error and a missing customer are indistinguishable from the outside.
 */
export async function getBusinessProfile(organizationId: string): Promise<BusinessProfile | null> {
  await requirePlatformAdmin();

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('platform_website_business_profile', {
    p_org: organizationId,
  });
  if (error) return null;

  // Set-returning functions come back as Json; narrowed here the same way the
  // other platform services narrow theirs.
  type Row = {
    organization_name: string;
    organization_slug: string;
    primary_module: string;
    currency: string;
    display_name: string | null;
    logo_url: string | null;
    primary_color: string | null;
    secondary_color: string | null;
    phone: string | null;
    whatsapp: string | null;
    email: string | null;
    opening_hours: unknown;
    branch_count: number | null;
  };
  const list = (Array.isArray(data) ? data : data == null ? [] : [data]) as Row[];
  const row = list[0];
  if (!row) return null;

  const hours = row.opening_hours;
  return {
    organizationName: row.organization_name,
    organizationSlug: row.organization_slug,
    primaryModule: row.primary_module,
    currency: row.currency,
    branding: {
      logoUrl: row.logo_url,
      displayName: row.display_name,
      primaryColor: row.primary_color,
      secondaryColor: row.secondary_color,
    },
    contact: { phone: row.phone, whatsapp: row.whatsapp, email: row.email },
    openingHours: Array.isArray(hours) ? (hours as OpeningHoursDay[]) : null,
    branchCount: row.branch_count ?? 0,
  };
}

/**
 * The site type a customer's vertical implies.
 *
 * A suggestion for the create form, not a rule: the operator may build a
 * `custom` site for a restaurant, and a module LocalBasic does not model yet
 * falls through to `custom` rather than failing.
 */
export function suggestedSiteType(primaryModule: string): string {
  const byModule: Record<string, string> = {
    restaurant: 'restaurant',
    retail: 'retail',
    medical: 'clinic',
    workshop: 'workshop',
  };
  return byModule[primaryModule] ?? 'custom';
}
