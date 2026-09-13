import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { clientEnv } from '@/lib/env';
import { isLocalDb } from './local/db';
import { createLocalClient } from './local/client';
import type { Database } from '@/types/database';

/**
 * The default server-side client: anon key + the caller's session cookie.
 *
 * Every read and write through this client is subject to RLS as that user.
 * Server Components, Server Actions and Route Handlers all use this.
 */
export function createSupabaseServerClient() {
  // Development escape hatch: with LOCALBASIC_LOCAL_DB=1 the app talks to a
  // local PostgreSQL directly so it can be run without a Supabase project.
  // RLS still applies — only the transport differs. Never active in production.
  if (isLocalDb()) {
    return createLocalClient() as unknown as ReturnType<typeof createServerClient<Database>>;
  }

  const cookieStore = cookies();

  return createServerClient<Database>(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        get: (name: string) => cookieStore.get(name)?.value,
        set: (name: string, value: string, options: CookieOptions) => {
          try {
            cookieStore.set({ name, value, ...options, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
          } catch {
            // Called from a Server Component, where cookies are read-only.
            // Middleware refreshes the session, so this is safe to ignore.
          }
        },
        remove: (name: string, options: CookieOptions) => {
          try {
            cookieStore.set({ name, value: '', ...options, maxAge: 0 });
          } catch {
            /* see above */
          }
        },
      },
    },
  );
}
