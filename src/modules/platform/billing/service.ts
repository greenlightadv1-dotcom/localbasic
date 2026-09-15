import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requirePlatformAdmin } from '@/modules/platform/admin/context';
import { AppError } from '@/lib/errors';
import { quoteInput, renewInput, createWorkspaceInput } from './schemas';

/**
 * Platform billing services.
 *
 * Every one of these calls a SECURITY DEFINER function that re-checks
 * app.require_platform_admin() in the database. requirePlatformAdmin() here is
 * for the UI's benefit — a clean 404 instead of a raw SQL error — and is never
 * the only thing standing between a caller and the data.
 */

export type OrganizationSummary = {
  id: string;
  customerCode: string;
  name: string;
  slug: string;
  primaryModule: string;
  status: string;
  createdAt: string;
  planKey: string | null;
  planNameAr: string | null;
  subscriptionStatus: string | null;
  billingPeriod: string | null;
  currentPeriodEnd: string | null;
  daysLeft: number | null;
};

/** Days until the term ends, floored. Negative once it has lapsed. */
function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

/**
 * The expiry warning threshold. Derived from current_period_end every time it
 * is asked for — there is no stored "expiring" flag to go stale.
 */
export const EXPIRY_WARNING_DAYS = 3;

export async function listOrganizations(search?: string): Promise<OrganizationSummary[]> {
  await requirePlatformAdmin();
  const supabase = createSupabaseServerClient();

  let query = supabase
    .from('organizations')
    .select(
      'id, customer_code, name, slug, primary_module, status, created_at, subscriptions(status, billing_period, current_period_end, plan_id)',
    )
    .order('created_at', { ascending: false })
    .limit(100);

  const term = search?.trim();
  if (term) {
    // Customer code, name or slug — one box, because an admin on the phone has
    // whichever of the three the caller happens to know.
    query = query.or(
      `customer_code.ilike.%${term}%,name.ilike.%${term}%,slug.ilike.%${term}%`,
    );
  }

  const { data, error } = await query;
  if (error) throw error;

  const { data: plans } = await supabase.from('plans').select('id, key, name_ar');
  const planById = new Map((plans ?? []).map((p) => [p.id, p]));

  return (data ?? []).map((row) => {
    const subs = (row.subscriptions ?? []) as {
      status: string; billing_period: string; current_period_end: string;
      plan_id: string;
    }[];
    const live = subs.find((s) => ['trialing', 'active', 'past_due'].includes(s.status)) ?? null;
    return {
      id: row.id,
      customerCode: row.customer_code,
      name: row.name,
      slug: row.slug,
      primaryModule: row.primary_module,
      status: row.status,
      createdAt: row.created_at,
      planKey: live ? planById.get(live.plan_id)?.key ?? null : null,
      planNameAr: live ? planById.get(live.plan_id)?.name_ar ?? null : null,
      subscriptionStatus: live?.status ?? null,
      billingPeriod: live?.billing_period ?? null,
      currentPeriodEnd: live?.current_period_end ?? null,
      daysLeft: daysUntil(live?.current_period_end ?? null),
    };
  });
}

export async function getOrganizationByCode(code: string): Promise<OrganizationSummary | null> {
  const rows = await listOrganizations(code);
  return rows.find((r) => r.customerCode.toLowerCase() === code.trim().toLowerCase()) ?? null;
}

export type SubscriptionEvent = {
  id: number;
  eventType: string;
  billingPeriod: string;
  periodStart: string;
  periodEnd: string;
  grossCents: number;
  discountCents: number;
  netCents: number;
  currency: string;
  paymentMethod: string;
  promoCode: string | null;
  note: string | null;
  createdAt: string;
  createdByLabel: string | null;
  planNameAr: string | null;
};

export async function listSubscriptionHistory(organizationId: string): Promise<SubscriptionEvent[]> {
  await requirePlatformAdmin();
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from('subscription_events')
    .select(
      'id, event_type, plan_id, billing_period, period_start, period_end, gross_cents, discount_cents, net_cents, currency, payment_method, promo_code, note, created_at, created_by_label',
    )
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;

  // Plan names are looked up separately rather than embedded: the catalogue is
  // four rows, and a nested embed here defeats postgrest-js's type inference.
  const { data: plans } = await supabase.from('plans').select('id, name_ar');
  const planName = new Map((plans ?? []).map((p) => [p.id, p.name_ar]));

  return (data ?? []).map((r) => ({
    id: r.id,
    eventType: r.event_type,
    billingPeriod: r.billing_period,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    grossCents: r.gross_cents,
    discountCents: r.discount_cents,
    netCents: r.net_cents,
    currency: r.currency,
    paymentMethod: r.payment_method,
    promoCode: r.promo_code,
    note: r.note,
    createdAt: r.created_at,
    createdByLabel: r.created_by_label,
    planNameAr: r.plan_id ? planName.get(r.plan_id) ?? null : null,
  }));
}

type QuoteRow = {
  valid: boolean; reason: string | null; months: number; trial_days: number;
  gross_cents: number; discount_cents: number; net_cents: number;
  currency: string; period_start: string; period_end: string;
};

export type Quote = {
  valid: boolean;
  reason: string | null;
  months: number;
  trialDays: number;
  grossCents: number;
  discountCents: number;
  netCents: number;
  currency: string;
  periodStart: string;
  periodEnd: string;
};

/**
 * Price a term without charging for it. The same function the write path calls,
 * so what the admin is shown is what the renewal will record.
 */
export async function quoteRenewal(input: unknown): Promise<Quote> {
  await requirePlatformAdmin();
  const parsed = quoteInput.safeParse(input);
  if (!parsed.success) throw new AppError('validation');

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('platform_quote_renewal', {
    p_organization_id: parsed.data.organizationId,
    p_plan_id: parsed.data.planId,
    p_billing_period: parsed.data.billingPeriod,
    p_promo_code: parsed.data.promoCode || null,
  });
  if (error) throw error;

  // Every RPC is typed Json by the generator, so each call site names the shape
  // it expects. The database is still the authority on the values.
  const row = (Array.isArray(data) ? data[0] : data) as QuoteRow | undefined;
  if (!row) throw new AppError('validation', 'تعذّر حساب السعر');

  return {
    valid: row.valid,
    reason: row.reason,
    months: row.months,
    trialDays: row.trial_days,
    grossCents: row.gross_cents,
    discountCents: row.discount_cents,
    netCents: row.net_cents,
    currency: row.currency,
    periodStart: row.period_start,
    periodEnd: row.period_end,
  };
}

/**
 * Take payment and move the term forward.
 *
 * Note what is NOT passed: no price, no discount, no dates. The database
 * recomputes the quote from the plan and the code, so a tampered form can
 * change which plan is bought but never what it costs.
 */
export async function renewSubscription(input: unknown): Promise<number> {
  await requirePlatformAdmin();
  const parsed = renewInput.safeParse(input);
  if (!parsed.success) throw new AppError('validation');

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('platform_renew_subscription', {
    p_organization_id: parsed.data.organizationId,
    p_plan_id: parsed.data.planId,
    p_billing_period: parsed.data.billingPeriod,
    p_promo_code: parsed.data.promoCode || null,
    p_payment_method: parsed.data.paymentMethod,
    p_note: parsed.data.note || null,
  });
  if (error) throw new AppError('validation', error.message);
  return data as number;
}

export type ExpiringRow = {
  organizationId: string;
  customerCode: string;
  organizationName: string;
  slug: string;
  planKey: string;
  status: string;
  billingPeriod: string;
  currentPeriodEnd: string;
  daysLeft: number;
};

export async function listExpiring(withinDays = EXPIRY_WARNING_DAYS): Promise<ExpiringRow[]> {
  await requirePlatformAdmin();
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase.rpc('platform_expiring_subscriptions', {
    p_within_days: withinDays,
  });
  if (error) throw error;

  type Row = {
    organization_id: string; customer_code: string; organization_name: string;
    slug: string; plan_key: string; status: string; billing_period: string;
    current_period_end: string; days_left: number;
  };

  return ((data ?? []) as Row[]).map((r) => ({
    organizationId: r.organization_id,
    customerCode: r.customer_code,
    organizationName: r.organization_name,
    slug: r.slug,
    planKey: r.plan_key,
    status: r.status,
    billingPeriod: r.billing_period,
    currentPeriodEnd: r.current_period_end,
    daysLeft: r.days_left,
  }));
}

export async function listPlans() {
  await requirePlatformAdmin();
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('plans')
    .select('id, key, name_ar, name_en, price_cents, currency, interval, limits, features, sort_order')
    .order('sort_order');
  if (error) throw error;
  return data ?? [];
}

export async function listPromoCodes() {
  await requirePlatformAdmin();
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('promo_codes')
    .select(
      'id, code, description, kind, percent_off, amount_off_cents, trial_days, starts_at, ends_at, max_redemptions, redeemed_count, is_active, new_customers_only, created_at',
    )
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return data ?? [];
}

/**
 * Provision a workspace for somebody else.
 *
 * The owner must already have an account: the database refuses an unknown
 * profile, and minting an auth user needs the service-role admin API, which is
 * a server-only path deliberately not wired into this flow yet.
 */
export async function createWorkspaceForOwner(input: unknown) {
  await requirePlatformAdmin();
  const parsed = createWorkspaceInput.safeParse(input);
  if (!parsed.success) throw new AppError('validation');

  const supabase = createSupabaseServerClient();

  const { data: profile } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', parsed.data.ownerEmail)
    .maybeSingle();

  // profiles has no email column — the address lives on auth.users — so the
  // owner is resolved by the caller passing a profile id. Until an admin-API
  // lookup exists this flow accepts an id, and the UI says so.
  const ownerId = profile?.id ?? parsed.data.ownerEmail;

  const { data, error } = await supabase.rpc('platform_create_workspace', {
    p_owner_user_id: ownerId,
    p_org_name: parsed.data.organizationName,
    p_slug: parsed.data.slug,
    p_module: parsed.data.module,
    p_branch_name: parsed.data.branchName || null,
  });
  if (error) throw new AppError('validation', error.message);
  return Array.isArray(data) ? data[0] : data;
}
