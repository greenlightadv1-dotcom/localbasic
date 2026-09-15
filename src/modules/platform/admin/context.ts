import 'server-only';
import { cache } from 'react';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireUser, type SessionUser } from '@/modules/core/tenancy/context';
import { notFound } from 'next/navigation';

/**
 * Platform Admin identity.
 *
 * Deliberately NOT part of TenantContext. A Platform Admin operates the SaaS;
 * they have no organization, no branch and no tenant permissions, and nothing
 * in tenant RBAC can imply this role. The two authorization systems never meet.
 *
 * The database is the real boundary — every platform function calls
 * app.require_platform_admin() itself — so this is the UI's copy of the answer,
 * not the enforcement.
 */
export type PlatformContext = {
  user: SessionUser;
  /** 'owner' may manage the admin roster; 'staff' may operate only. */
  role: 'owner' | 'staff';
};

/** The platform admin record for the signed-in user, or null. Cached per request. */
export const getPlatformContext = cache(async (): Promise<PlatformContext | null> => {
  const user = await requireUser().catch(() => null);
  if (!user) return null;

  const supabase = createSupabaseServerClient();
  const { data } = await supabase
    .from('platform_admins')
    .select('role, is_active')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!data || !data.is_active) return null;
  return { user, role: data.role as 'owner' | 'staff' };
});

/**
 * Gate for every /admin surface.
 *
 * 404, not 403: a tenant user probing /admin learns only that the path does not
 * exist for them, which is the same answer the rest of the platform gives for
 * a resource they may not see.
 */
export async function requirePlatformAdmin(): Promise<PlatformContext> {
  const ctx = await getPlatformContext();
  if (!ctx) notFound();
  return ctx;
}
