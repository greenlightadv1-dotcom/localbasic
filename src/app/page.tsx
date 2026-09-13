import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { listMyWorkspaces } from '@/modules/core/tenancy/service';

/**
 * Entry point. Routes the visitor to the right place rather than rendering a
 * landing page: signed out → sign-in, no workspace → onboarding, otherwise
 * straight into their workspace.
 */
export default async function RootPage() {
  const supabase = createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect('/sign-in');

  const workspaces = await listMyWorkspaces();
  if (workspaces.length === 0) redirect('/onboarding');

  redirect(`/${workspaces[0]!.slug}`);
}
