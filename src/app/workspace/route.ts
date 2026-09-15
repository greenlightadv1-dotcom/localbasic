import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { listMyWorkspaces } from '@/modules/core/tenancy/service';

export const dynamic = 'force-dynamic';

/**
 * Signed-in entry point. `/` is the public marketing site now, so the "where
 * does this user belong" routing that used to live there lives here: signed
 * out → sign-in, no workspace → onboarding, otherwise their first workspace.
 *
 * A route handler so each hop is a real 307 rather than a meta-refresh flash.
 */
export async function GET(request: NextRequest) {
  const to = (path: string) =>
    NextResponse.redirect(new URL(path, request.nextUrl.origin), 307);

  const supabase = createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return to('/sign-in');

  const workspaces = await listMyWorkspaces();
  if (workspaces.length === 0) return to('/onboarding');

  return to(`/${workspaces[0]!.slug}`);
}
