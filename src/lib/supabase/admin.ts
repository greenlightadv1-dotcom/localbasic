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
  return createClient<Database>(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    serverEnv().SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
