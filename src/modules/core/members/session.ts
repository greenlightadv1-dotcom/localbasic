import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * The signed-in user, or null — without requiring a tenant.
 *
 * `resolveTenantContext` needs an organization the caller already belongs to,
 * which is exactly what someone accepting an invitation does not have yet.
 */
export async function currentUser(): Promise<{ id: string; email: string | null } | null> {
  const supabase = createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}
