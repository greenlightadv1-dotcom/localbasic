import 'server-only';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requirePermission, type TenantContext } from '@/modules/core/tenancy/context';
import { AppError } from '@/lib/errors';
import { challengeName, getDomainVerifier } from './domain-verifier';
import { DOMAIN_STATUSES, type DomainStatus, type WebsiteDomain } from './domains-shared';

export * from './domains-shared';

/**
 * Custom domains.
 *
 * The tenant comes from the context the URL resolved; every write re-checks
 * `settings.manage` and the database re-checks it again inside each function.
 * Nothing here accepts an organization id.
 *
 * Verification is the only operation that reaches outside: it asks DNS what
 * TXT records exist and hands those values to the database, which hashes them
 * against the stored challenge. This layer never decides that a domain is
 * verified — it cannot, because it does not hold the hash.
 */

/**
 * A hostname, as the browser may send it.
 *
 * Deliberately permissive: this catches obvious nonsense early for a better
 * message, and `app.normalize_hostname` in the database is the real arbiter of
 * what a hostname is.
 */
export const hostnameInput = z
  .string()
  .trim()
  .min(4, 'اسم النطاق قصير جدًا')
  .max(253, 'اسم النطاق طويل جدًا')
  .refine((v) => !/[\s/?#@]|:\/\//.test(v), 'أدخل اسم النطاق فقط، بدون http أو مسار');

const domainId = z.string().uuid();

function rows<T>(data: unknown): T[] {
  return (Array.isArray(data) ? data : data == null ? [] : [data]) as T[];
}

export async function listDomains(ctx: TenantContext): Promise<WebsiteDomain[]> {
  requirePermission(ctx, 'settings.manage');
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase.rpc('restaurant_domains_list', {
    p_org_slug: ctx.organizationSlug,
  });
  if (error) throw error;

  type Row = {
    id: string; hostname: string; status: string; is_primary: boolean;
    verification_method: string; verification_attempted_at: string | null;
    verification_error: string | null; verified_at: string | null;
    activated_at: string | null; created_at: string;
  };

  return rows<Row>(data).map((r) => ({
    id: r.id,
    hostname: r.hostname,
    status: (DOMAIN_STATUSES as readonly string[]).includes(r.status)
      ? (r.status as DomainStatus)
      : 'pending',
    isPrimary: Boolean(r.is_primary),
    verificationMethod: r.verification_method,
    verificationAttemptedAt: r.verification_attempted_at,
    verificationError: r.verification_error,
    verifiedAt: r.verified_at,
    activatedAt: r.activated_at,
    createdAt: r.created_at,
  }));
}

/**
 * Add a domain.
 *
 * Returns the challenge value, which is the only time it exists in readable
 * form — the database stores a hash. The caller shows it once and does not
 * persist it.
 */
export async function addDomain(
  ctx: TenantContext,
  hostname: unknown,
): Promise<{ id: string; hostname: string; token: string }> {
  requirePermission(ctx, 'settings.manage');
  const parsed = hostnameInput.safeParse(hostname);
  if (!parsed.success) {
    throw new AppError('validation', parsed.error.issues[0]?.message ?? 'اسم نطاق غير صالح');
  }

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('restaurant_domain_add', {
    p_org_slug: ctx.organizationSlug,
    p_hostname: parsed.data,
  });
  if (error) throw new AppError('validation', error.message);

  const row = rows<{ out_id: string; out_hostname: string; out_token: string }>(data)[0];
  if (!row) throw new AppError('validation', 'تعذّر إضافة النطاق');
  return { id: row.out_id, hostname: row.out_hostname, token: row.out_token };
}

/**
 * Verify ownership.
 *
 * Looks the TXT records up for real and passes what DNS returned to the
 * database. A failed lookup is reported as a failed attempt — never as a
 * silent success, and never as a verification.
 */
export async function verifyDomain(
  ctx: TenantContext,
  id: unknown,
  hostname: string,
): Promise<{ verified: boolean; status: DomainStatus; error: string | null }> {
  requirePermission(ctx, 'settings.manage');
  const parsed = domainId.safeParse(id);
  if (!parsed.success) throw new AppError('validation');

  let values: string[] = [];
  let lookupError: string | null = null;
  try {
    values = await getDomainVerifier().lookupTxt(challengeName(hostname));
  } catch (error) {
    lookupError = error instanceof Error ? error.message : 'تعذّر الاستعلام عن DNS';
  }

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('restaurant_domain_record_verification', {
    p_org_slug: ctx.organizationSlug,
    p_domain_id: parsed.data,
    p_txt_values: values,
    p_error: lookupError,
  });
  if (error) throw new AppError('validation', error.message);

  const row = rows<{ out_status: string; out_verified: boolean }>(data)[0];
  return {
    verified: Boolean(row?.out_verified),
    status: (row?.out_status ?? 'pending') as DomainStatus,
    error: lookupError,
  };
}

export async function setDomainStatus(
  ctx: TenantContext,
  id: unknown,
  status: 'active' | 'disabled',
): Promise<void> {
  requirePermission(ctx, 'settings.manage');
  const parsed = domainId.safeParse(id);
  if (!parsed.success) throw new AppError('validation');

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('restaurant_domain_set_status', {
    p_org_slug: ctx.organizationSlug,
    p_domain_id: parsed.data,
    p_status: status,
  });
  if (error) throw new AppError('validation', error.message);
}

export async function setPrimaryDomain(ctx: TenantContext, id: unknown): Promise<void> {
  requirePermission(ctx, 'settings.manage');
  const parsed = domainId.safeParse(id);
  if (!parsed.success) throw new AppError('validation');

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('restaurant_domain_set_primary', {
    p_org_slug: ctx.organizationSlug,
    p_domain_id: parsed.data,
  });
  if (error) throw new AppError('validation', error.message);
}

export async function removeDomain(ctx: TenantContext, id: unknown): Promise<void> {
  requirePermission(ctx, 'settings.manage');
  const parsed = domainId.safeParse(id);
  if (!parsed.success) throw new AppError('validation');

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('restaurant_domain_remove', {
    p_org_slug: ctx.organizationSlug,
    p_domain_id: parsed.data,
  });
  if (error) throw new AppError('validation', error.message);
}

export type ResolvedHost = {
  orgSlug: string;
  /** Set when this hostname is active but another one is the canonical address. */
  redirectTo: string | null;
};

/**
 * Resolve a public hostname to a restaurant.
 *
 * The only part of this module that serves anonymous traffic, and the only
 * question it answers is "which restaurant, if any". An inactive domain, an
 * unpublished website or a hostname nobody owns all return null — identically,
 * so a probe learns nothing from the difference.
 */
export async function resolveHost(hostname: string): Promise<ResolvedHost | null> {
  if (!hostname) return null;

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('restaurant_domain_resolve', {
    p_hostname: hostname,
  });
  if (error) return null;

  const row = rows<{ org_slug: string; redirect_to: string | null }>(data)[0];
  if (!row?.org_slug) return null;
  return { orgSlug: row.org_slug, redirectTo: row.redirect_to };
}
