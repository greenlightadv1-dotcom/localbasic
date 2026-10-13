import 'server-only';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { AppError } from '@/lib/errors';
import { usernameToEmail } from '@/lib/auth/username';
import { serverEnv } from '@/lib/env';

/** The exact variable an operator must set for account creation to work. */
const SERVICE_ROLE_ENV = 'SUPABASE_SERVICE_ROLE_KEY';

/**
 * Username + password accounts, created and re-keyed by someone else.
 *
 * Three callers share this so the rules cannot drift apart: an admin creating
 * a staff member, a platform super-admin creating a restaurant owner, and
 * either of them resetting a password. All of it needs the Supabase Admin API
 * (SUPABASE_SERVICE_ROLE_KEY) — the same requirement account creation always
 * had — and none of it is reachable from a signed-in user's own session.
 *
 * `mustChangePassword` is true only for restaurant owners/admins, whose
 * password is a temporary one they must replace on first login. Staff never get
 * the flag: they have no way to change a password themselves.
 */

export function requireProvisioning(): void {
  if (!serverEnv().SUPABASE_SERVICE_ROLE_KEY) {
    throw new AppError(
      'validation',
      `إنشاء الحسابات غير مُهيأ على الخادم. اضبط ${SERVICE_ROLE_ENV}.`,
    );
  }
}

function adminApiMessage(message: string | undefined, fallback: string): string {
  if (/invalid api key/i.test(message ?? '')) {
    return `مفتاح ${SERVICE_ROLE_ENV} في إعدادات النشر غير صحيح أو منتهٍ.`;
  }
  return `${fallback}: ${message ?? 'خطأ غير معروف'}`;
}

/** Creates the auth account and stamps the username/flag on its profile. */
export async function createLoginAccount(input: {
  username: string;
  password: string;
  fullName: string;
  mustChangePassword: boolean;
}): Promise<{ userId: string }> {
  requireProvisioning();
  const admin = createSupabaseAdminClient();

  const { data, error } = await admin.auth.admin.createUser({
    email: usernameToEmail(input.username),
    password: input.password,
    email_confirm: true,
    user_metadata: { full_name: input.fullName },
  });

  if (error || !data.user) {
    const taken = /already.*registered|already.*exists/i.test(error?.message ?? '');
    throw new AppError(
      'validation',
      taken ? 'اسم المستخدم مستخدم بالفعل. اختر اسمًا آخر.' : adminApiMessage(error?.message, 'تعذّر إنشاء الحساب'),
    );
  }

  const userId = data.user.id;
  const { error: profileError } = await admin
    .from('profiles')
    .update({ username: input.username, must_change_password: input.mustChangePassword })
    .eq('id', userId);

  if (profileError) {
    // A login with no username on its profile would be unlabeled everywhere
    // and could never be told apart from a duplicate. Remove it.
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    throw new AppError('validation', 'تعذّر إنشاء الحساب.');
  }

  return { userId };
}

/** Removes an account created by createLoginAccount (workspace half failed). */
export async function discardLoginAccount(userId: string): Promise<void> {
  await createSupabaseAdminClient().auth.admin.deleteUser(userId).catch(() => {});
}

/** Assigns a new password directly. The caller has already authorised it. */
export async function setLoginPassword(
  userId: string,
  password: string,
  mustChangePassword: boolean,
): Promise<void> {
  requireProvisioning();
  const admin = createSupabaseAdminClient();

  const { error } = await admin.auth.admin.updateUserById(userId, { password });
  if (error) {
    throw new AppError('validation', adminApiMessage(error.message, 'تعذّر تغيير كلمة المرور'));
  }

  const { error: profileError } = await admin
    .from('profiles')
    .update({ must_change_password: mustChangePassword })
    .eq('id', userId);
  if (profileError) throw new AppError('validation', 'تعذّر تحديث الحساب.');
}

/** The user's own forced-change flag cleared, after they chose a password. */
export async function clearMustChangePassword(userId: string): Promise<void> {
  const admin = createSupabaseAdminClient();
  const { error } = await admin
    .from('profiles')
    .update({ must_change_password: false })
    .eq('id', userId);
  if (error) throw new AppError('validation', 'تعذّر تحديث الحساب.');
}
