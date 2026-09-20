import 'server-only';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AppError, conflict, toAppError } from '@/lib/errors';
import { slugify } from '@/lib/tokens';
import { isIanaTimeZone } from '@/lib/time';
import { requireUser } from './context';

/** Used when a caller supplies no timezone at all. */
export const DEFAULT_TIMEZONE = 'Africa/Cairo';

export const MODULE_KEYS = ['retail', 'restaurant', 'medical', 'workshop'] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

export const provisionWorkspaceSchema = z.object({
  organizationName: z.string().trim().min(2, 'اسم النشاط مطلوب').max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, 'المعرّف 3 أحرف على الأقل')
    .max(50)
    .regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/, 'حروف إنجليزية وأرقام وشرطات فقط'),
  moduleKey: z.enum(MODULE_KEYS),
  branchName: z.string().trim().min(1).max(120).optional(),
  country: z.string().trim().length(2).default('EG'),
  currency: z.string().trim().length(3).default('EGP'),
  /**
   * The organization's IANA timezone. Every report boundary is derived from
   * it, so a bad value is not cosmetic: it decides which day a sale lands on.
   *
   * Validation is server-side and authoritative — the onboarding form posts a
   * hidden field, which is to say the browser can post anything.
   *
   * Missing means "use the platform default" (`DEFAULT_TIMEZONE`). Supplied
   * and invalid is an ERROR, never a silent fallback: quietly rewriting a
   * tenant's zone would put their reports on the wrong day without telling
   * anyone. Whitespace is trimmed first, so ' Africa/Cairo ' is accepted and
   * persisted as 'Africa/Cairo'; empty and whitespace-only are rejected.
   */
  timezone: z
    .string()
    .trim()
    .refine(isIanaTimeZone, 'المنطقة الزمنية غير صالحة')
    .default(DEFAULT_TIMEZONE),
});

export type ProvisionWorkspaceInput = z.infer<typeof provisionWorkspaceSchema>;

/**
 * Organizations the signed-in user belongs to.
 *
 * The user filter is explicit and must stay that way. RLS alone is not an
 * identity filter here: a Platform Admin is granted read over every row of
 * organization_members so the platform console can list customers, so relying
 * on the policy to mean "mine" returned every tenant on the platform to them.
 * The caller then treated the first row as the user's own workspace.
 */
export async function listMyWorkspaces() {
  const user = await requireUser();
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('organization_members')
    .select('organization_id, status, organizations!inner(slug, name, primary_module, status)')
    .eq('user_id', user.id)
    .eq('status', 'active');

  if (error) throw toAppError(error, 'listMyWorkspaces');

  return (data ?? [])
    .map((row) => {
      const org = row.organizations as unknown as {
        slug: string;
        name: string;
        primary_module: string;
        status: string;
      } | null;
      return org && org.status === 'active'
        ? { slug: org.slug, name: org.name, moduleKey: org.primary_module }
        : null;
    })
    .filter((x): x is { slug: string; name: string; moduleKey: string } => x !== null);
}

export async function isSlugAvailable(slug: string): Promise<boolean> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('is_org_slug_available', { p_slug: slug });
  if (error) throw toAppError(error, 'isSlugAvailable');
  return data === true;
}

export function suggestSlug(name: string): string {
  const base = slugify(name);
  // Arabic names slugify to an empty ASCII string; fall back to a stable prefix
  // the user can edit rather than failing the form.
  return /^[a-z0-9][a-z0-9-]*$/.test(base) && base.length >= 3 ? base : '';
}

/**
 * Creates a complete workspace.
 *
 * The entire sequence — organization, module, branch, membership, cloned roles
 * and permissions, owner grant, trial subscription, branding, settings,
 * document counters, cash drawer, audit entry — runs inside one PostgreSQL
 * function, so it is a single transaction. There is no partially provisioned
 * state to recover from.
 */
export async function provisionWorkspace(input: ProvisionWorkspaceInput) {
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .rpc('provision_workspace', {
      p_org_name: input.organizationName,
      p_slug: input.slug,
      p_module: input.moduleKey,
      p_branch_name: input.branchName ?? null,
      p_country: input.country,
      p_currency: input.currency,
      p_timezone: input.timezone,
      p_locale: 'ar',
    })
    .single();

  if (error) {
    // 23505 = unique_violation, i.e. the slug was taken between the
    // availability check and the insert.
    if (error.code === '23505') throw conflict('هذا المعرّف مستخدم بالفعل. اختر معرّفًا آخر.');
    throw toAppError(error, 'provisionWorkspace');
  }

  const row = data as unknown as {
    out_organization_id: string;
    out_organization_slug: string;
    out_branch_id: string;
  } | null;

  if (!row) throw new AppError('internal');

  return {
    organizationId: row.out_organization_id,
    organizationSlug: row.out_organization_slug,
    branchId: row.out_branch_id,
  };
}
