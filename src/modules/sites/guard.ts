import 'server-only';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Sends a signed-out visitor to sign-in instead of an error page.
 *
 * The services still call requireUser(), which throws `unauthenticated` — that
 * is the right answer for a programmatic caller. For a person who followed a
 * bookmark it is the wrong one: they would meet "حدث خطأ" with no way forward.
 * `/workspace` already resolves this the same way, with a real redirect.
 *
 * This is a UX affordance, not the security boundary. Ownership is enforced by
 * RLS on every one of the four tables; removing this function would make the
 * pages uglier, not less safe.
 */
export async function requireSignedIn(): Promise<void> {
  const supabase = createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect('/sign-in');
}
