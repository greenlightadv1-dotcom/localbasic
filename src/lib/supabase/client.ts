'use client';
import { createBrowserClient } from '@supabase/ssr';
import { clientEnv } from '@/lib/env';
import type { Database } from '@/types/database';

/**
 * Browser client. Anon key only — RLS is the authority for everything it can
 * see. Used for auth flows and realtime subscriptions, never for privileged
 * reads or for anything that decides authorization.
 */
export function createSupabaseBrowserClient() {
  return createBrowserClient<Database>(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}
