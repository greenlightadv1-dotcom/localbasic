import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { clientEnv, serverEnv } from '@/lib/env';
import { isLocalDb } from './local/db';
import { createLocalServiceClient } from './local/client';
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
  // Development escape hatch, mirroring ./server.ts: with LOCALBASIC_LOCAL_DB=1
  // the app talks to a local PostgreSQL directly and the service role is a
  // `set role`, not a key. Never active in production — isLocalDb() is false
  // there and the pool refuses to open.
  if (isLocalDb()) {
    return createLocalServiceClient() as unknown as ReturnType<typeof createClient<Database>>;
  }

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
