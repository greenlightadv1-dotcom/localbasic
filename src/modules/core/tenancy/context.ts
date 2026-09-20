import 'server-only';
import { cache } from 'react';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { forbidden, unauthenticated } from '@/lib/errors';
import type { Permission } from '@/modules/core/rbac/permissions';

/**
 * Everything a service needs to act on behalf of a user, resolved once per
 * request from the session cookie and the URL.
 *
 * Services take a TenantContext as their first argument and never read cookies
 * or headers themselves. That makes forgetting the tenant a type error rather
 * than a security incident, and keeps services directly testable.
 */
export type TenantContext = {
  userId: string;
  /** The signed-in person's name, for the header. */
  fullName: string | null;
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
  currency: string;
  locale: 'ar' | 'en';
  /**
   * The organization's IANA timezone, e.g. 'Africa/Cairo'.
   *
   * Reports decide what "today" means with it. Carried on the context rather
   * than fetched per report: it rides the membership query that resolves this
   * context anyway, so it costs nothing extra and cannot be supplied by a
   * browser.
   */
  timezone: string;
  /** The branch the user is currently acting in. */
  branchId: string;
  branchSlug: string;
  branchName: string;
  /** Every branch this user may reach, for switchers and cross-branch reports. */
  branches: { id: string; slug: string; name: string }[];
  permissions: Set<Permission>;
  roleKeys: string[];
  isOwner: boolean;
  enabledModules: string[];
  primaryModule: string;
};

export type SessionUser = { id: string; email: string | null; fullName: string | null };

/** The signed-in user, or an `unauthenticated` error. Cached per request. */
export const requireUser = cache(async (): Promise<SessionUser> => {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw unauthenticated();
  return {
    id: data.user.id,
    email: data.user.email ?? null,
    fullName: (data.user.user_metadata?.full_name as string | undefined) ?? null,
  };
});

/**
 * Resolve the tenant context for an org/branch pair taken from the URL.
 *
 * Throws `forbidden` — which renders as 404 — when the user is not a member or
 * cannot reach the branch, so organization slugs cannot be probed for
 * existence by an outsider.
 *
 * Membership is looked up explicitly, and that is the gate. It used to be
 * inferred from whether RLS let the organization row be read, which stopped
 * being the same question once the platform console was given read over every
 * organization, member and branch: a Platform Admin could then walk into any
 * tenant's workspace and land in a shell with no permissions at all. Reading a
 * tenant's data to operate the SaaS is not belonging to it, and nothing in
 * platform authorization may imply a tenant role.
 */
export const resolveTenantContext = cache(
  async (organizationSlug: string, branchSlug?: string): Promise<TenantContext> => {
    const user = await requireUser();
    const supabase = createSupabaseServerClient();

    const { data: membership } = await supabase
      .from('organization_members')
      .select(
        'id, all_branches, organizations!inner(id, slug, name, currency, default_locale, primary_module, timezone)',
      )
      .eq('user_id', user.id)
      .eq('status', 'active')
      .eq('organizations.slug', organizationSlug)
      .is('organizations.deleted_at', null)
      .maybeSingle();

    // No membership means "not a member" and "does not exist" alike — as
    // intended, and now true for a Platform Admin as well.
    if (!membership) throw forbidden();

    const org = membership.organizations as unknown as {
      id: string;
      slug: string;
      name: string;
      currency: string;
      default_locale: string | null;
      primary_module: string;
      timezone: string | null;
    };

    const [{ data: branchRows }, { data: memberBranches }, { data: modules }, { data: grants }] =
      await Promise.all([
        supabase
          .from('branches')
          .select('id, slug, name')
          .eq('organization_id', org.id)
          .eq('is_active', true)
          .is('deleted_at', null)
          .order('created_at', { ascending: true }),
        supabase.from('member_branches').select('branch_id').eq('member_id', membership.id),
        supabase
          .from('organization_modules')
          .select('module_key')
          .eq('organization_id', org.id)
          .eq('enabled', true),
        supabase
          .from('user_roles')
          .select(
            'branch_id, roles!inner(key, is_owner, organization_id, role_permissions(permission_key))',
          )
          .eq('roles.organization_id', org.id),
      ]);

    // Branch scope comes from the membership, not from what RLS returns: the
    // platform read policy on branches is not scoped to a branch assignment,
    // so a Platform Admin who is also a member of one branch would otherwise
    // see every branch of that organization.
    const assigned = membership.all_branches
      ? null
      : new Set((memberBranches ?? []).map((b) => b.branch_id));
    const branches = (branchRows ?? []).filter((b) => assigned === null || assigned.has(b.id));
    if (branches.length === 0) throw forbidden();

    const branch = branchSlug
      ? branches.find((b) => b.slug === branchSlug)
      : branches[0];
    if (!branch) throw forbidden();

    // A grant counts for this branch when it is organization-wide
    // (branch_id null) or scoped to exactly this branch.
    const permissions = new Set<Permission>();
    const roleKeys: string[] = [];
    let isOwner = false;

    for (const grant of grants ?? []) {
      const role = grant.roles as unknown as {
        key: string;
        is_owner: boolean;
        role_permissions: { permission_key: string }[];
      } | null;
      if (!role) continue;
      if (!roleKeys.includes(role.key)) roleKeys.push(role.key);
      if (grant.branch_id !== null && grant.branch_id !== branch.id) continue;
      if (role.is_owner) isOwner = true;
      for (const rp of role.role_permissions ?? []) {
        permissions.add(rp.permission_key as Permission);
      }
    }

    return {
      userId: user.id,
      fullName: user.fullName,
      organizationId: org.id,
      organizationSlug: org.slug,
      organizationName: org.name,
      currency: org.currency,
      locale: (org.default_locale as 'ar' | 'en') ?? 'ar',
      // NOT NULL in the schema with a default, so the fallback is for a row
      // written before the column existed rather than an expected case.
      timezone: org.timezone ?? 'UTC',
      branchId: branch.id,
      branchSlug: branch.slug,
      branchName: branch.name,
      branches,
      permissions,
      roleKeys,
      isOwner,
      enabledModules: (modules ?? []).map((m) => m.module_key),
      primaryModule: org.primary_module,
    };
  },
);

export function can(ctx: TenantContext, permission: Permission): boolean {
  return ctx.permissions.has(permission);
}

export function canAny(ctx: TenantContext, permissions: readonly Permission[]): boolean {
  return permissions.some((p) => ctx.permissions.has(p));
}

/**
 * Server-side authorization gate. This is enforcement, not decoration — the UI
 * hiding a button is cosmetic, and RLS backs this up in the database.
 */
export function requirePermission(ctx: TenantContext, permission: Permission): void {
  if (!ctx.permissions.has(permission)) throw forbidden(`missing permission ${permission}`);
}
