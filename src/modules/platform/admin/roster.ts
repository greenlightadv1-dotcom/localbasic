import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { AppError } from '@/lib/errors';
import { ownerProvisioningAvailable, SERVICE_ROLE_ENV } from '@/modules/platform/onboarding/service';
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

/**
 * Create a brand-new platform-staff account directly, with a password an
 * owner sets, and grant it in the same step.
 *
 * grantPlatformAdmin() above only ever promotes an EXISTING identity, by
 * design (its own docstring: "there is no path here to create an account
 * that did not exist"). This is that path, for the same reason
 * createMemberDirect() exists alongside tenant invitations: an owner handing
 * a new operator a working login on the spot, with no email round trip and
 * no forced password change — they sign in with exactly the password
 * entered here.
 *
 * IDENTITY (Supabase Admin API) then WORKSPACE (platform_admin_grant, which
 * already re-checks app.require_platform_owner() itself — this call is not
 * the authorization, the same relationship every other action on this
 * surface has with its own database function). If the grant fails after the
 * account was created, the account is deleted rather than left a
 * password-having identity with no platform role at all.
 */
export async function createPlatformAdminDirect(
  email: string,
  password: string,
  fullName: string,
  role: 'owner' | 'staff',
  note?: string,
): Promise<void> {
  await requirePlatformAdmin();

  if (!ownerProvisioningAvailable()) {
    throw new AppError(
      'validation',
      `إنشاء الحسابات مباشرةً غير مُهيأ على الخادم. اضبط ${SERVICE_ROLE_ENV}.`,
    );
  }

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email: email.trim().toLowerCase(),
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });

  if (error || !data.user) {
    const already = /already.*registered|already.*exists/i.test(error?.message ?? '');
    const badKey = /invalid api key/i.test(error?.message ?? '');
    throw new AppError(
      'validation',
      already
        ? 'هذا البريد مسجّل بحساب بالفعل. استخدم "منح الصلاحية" أدناه بدلًا من الإنشاء المباشر.'
        : badKey
          ? `تعذّر إنشاء الحساب: مفتاح ${SERVICE_ROLE_ENV} في إعدادات النشر غير صحيح أو منتهٍ.`
          : `تعذّر إنشاء الحساب: ${error?.message ?? 'خطأ غير معروف'}`,
    );
  }

  const userId = data.user.id;
  const supabase = createSupabaseServerClient();
  const { error: rpcError } = await supabase.rpc('platform_admin_grant', {
    p_email: email.trim(),
    p_role: role,
    p_note: note?.trim() || null,
  });

  if (rpcError) {
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    throw new AppError('validation', rpcError.message);
  }
}

export async function revokePlatformAdmin(userId: string): Promise<void> {
  await requirePlatformAdmin();
  const supabase = createSupabaseServerClient();

  const { error } = await supabase.rpc('platform_admin_revoke', { p_user_id: userId });
  if (error) throw new AppError('validation', error.message);
}
