import 'server-only';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const CHANGE_PASSWORD_PATH = '/change-password';

/**
 * Whether the signed-in user was given a temporary password and has not yet
 * replaced it. Read through the user's own session (profiles_select_self), so
 * it needs no service role. False when signed out or when the column is
 * unreadable — the gate must never lock out a healthy session on a read error.
 */
export async function mustChangePassword(): Promise<boolean> {
  try {
    const supabase = createSupabaseServerClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return false;
    const { data } = await supabase
      .from('profiles')
      .select('must_change_password')
      .eq('id', auth.user.id)
      .maybeSingle();
    return Boolean((data as { must_change_password?: boolean } | null)?.must_change_password);
  } catch {
    return false;
  }
}

/** Layout guard: nothing behind it renders until the temporary password is replaced. */
export async function redirectIfMustChangePassword(): Promise<void> {
  if (await mustChangePassword()) redirect(CHANGE_PASSWORD_PATH);
}
