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
 * Every query below runs under the user's own RLS, so this function cannot see
 * more than the user is entitled to either.
 */
export const resolveTenantContext = cache(
  async (organizationSlug: string, branchSlug?: string): Promise<TenantContext> => {
    const user = await requireUser();
    const supabase = createSupabaseServerClient();

    const { data: org } = await supabase
      .from('organizations')
      .select('id, slug, name, currency, default_locale, primary_module')
      .eq('slug', organizationSlug)
      .is('deleted_at', null)
      .maybeSingle();

    // RLS already restricted this to organizations the user belongs to, so a
    // miss means "not a member" and "does not exist" alike — as intended.
    if (!org) throw forbidden();

    const [{ data: branchRows }, { data: modules }, { data: grants }] = await Promise.all([
      supabase
        .from('branches')
        .select('id, slug, name')
        .eq('organization_id', org.id)
        .eq('is_active', true)
        .is('deleted_at', null)
        .order('created_at', { ascending: true }),
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

    const branches = branchRows ?? [];
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
