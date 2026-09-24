import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AppError } from '@/lib/errors';
import { requirePermission, type TenantContext } from '@/modules/core/tenancy/context';

/**
 * Removing a staff member.
 *
 * One RPC, member_remove() (0064): deletes user_roles, member_branches and
 * the organization_members row for one member, refusing to remove the
 * organization's owner of record or anyone holding an is_owner role.
 *
 * Nothing further to revoke on the server: every permission check in this
 * codebase reads organization_members/user_roles live on each request, so
 * the removed member's very next request already fails authorization. The
 * realtime listener (./realtime) is for signing an already-open tab out
 * immediately, not for the server side of this to be correct.
 */
export async function removeMember(ctx: TenantContext, memberId: string): Promise<void> {
  requirePermission(ctx, 'member.manage');
  const supabase = createSupabaseServerClient();

  const { error } = await supabase.rpc('member_remove', {
    p_org: ctx.organizationId,
    p_member: memberId,
  });
  if (error) throw new AppError('validation', error.message);
}
