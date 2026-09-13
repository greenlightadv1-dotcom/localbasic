import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { clientEnv, serverEnv } from '@/lib/env';
import type { Database } from '@/types/database';

/**
 * SERVICE ROLE CLIENT — BYPASSES ROW LEVEL SECURITY.
 *
 * Permitted callers, and no others:
 *   * background workers (notification delivery, billing webhooks)
 *   * platform maintenance scripts
 *
 * Anything acting on behalf of a signed-in user must use the server client in
 * ./server.ts so RLS applies. The `server-only` import above makes bundling
 * this into client code a build error rather than a silent leak.
 */
export function createSupabaseAdminClient() {
  const key = serverEnv().SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not set. It is required only for background ' +
        'workers and platform maintenance, and must never be exposed to the client.',
    );
  }
  return createClient<Database>(clientEnv.NEXT_PUBLIC_SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
