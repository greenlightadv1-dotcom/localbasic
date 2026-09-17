import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AppError } from '@/lib/errors';
import { requirePlatformAdmin } from './context';

/**
 * The Platform Admin roster.
 *
 * The database is the boundary, as everywhere else on this surface: each
 * function below calls `app.require_platform_admin()` or
 * `app.require_platform_owner()` itself, and `platform_admins` still has no
 * write policy. This layer adds the screen's copy of the check so the UI can
 * show the right buttons, never the authorization itself.
 *
 * The FIRST admin is deliberately not creatable here. See migration 0048.
 */

export type PlatformAdminRow = {
  userId: string;
  email: string;
  fullName: string | null;
  role: 'owner' | 'staff';
  isActive: boolean;
  note: string | null;
  createdAt: string;
};

function rows<T>(data: unknown): T[] {
  return (Array.isArray(data) ? data : data == null ? [] : [data]) as T[];
}

export async function listPlatformAdmins(): Promise<PlatformAdminRow[]> {
  await requirePlatformAdmin();
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase.rpc('platform_admin_list');
  if (error) throw new AppError('validation', error.message);

  type Row = {
    out_user_id: string; out_email: string; out_full_name: string | null;
    out_role: string; out_is_active: boolean; out_note: string | null;
    out_created_at: string;
  };
  return rows<Row>(data).map((r) => ({
    userId: r.out_user_id,
    email: r.out_email,
    fullName: r.out_full_name,
    role: r.out_role === 'owner' ? 'owner' : 'staff',
    isActive: Boolean(r.out_is_active),
    note: r.out_note,
    createdAt: r.out_created_at,
  }));
}

/**
 * Promote an existing account.
 *
 * By email, because that is what an operator knows about a colleague. The
 * person must already have an account — this grants a role, it never mints an
 * identity.
 */
export async function grantPlatformAdmin(
  email: string,
  role: 'owner' | 'staff',
  note?: string,
): Promise<void> {
  await requirePlatformAdmin();
  const supabase = createSupabaseServerClient();

  const { error } = await supabase.rpc('platform_admin_grant', {
    p_email: email.trim(),
    p_role: role,
    p_note: note?.trim() || null,
  });
  if (error) throw new AppError('validation', error.message);
}

export async function revokePlatformAdmin(userId: string): Promise<void> {
  await requirePlatformAdmin();
  const supabase = createSupabaseServerClient();

  const { error } = await supabase.rpc('platform_admin_revoke', { p_user_id: userId });
  if (error) throw new AppError('validation', error.message);
}
