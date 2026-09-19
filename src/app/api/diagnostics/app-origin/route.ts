import 'server-only';
import { NextResponse } from 'next/server';
import {
  appOrigin,
  appOriginSource,
  isLoopbackOrigin,
  recoveryRedirectUrl,
} from '@/lib/auth/redirects';

/**
 * Reports how the application resolves its own public address.
 *
 * This exists because the failure it diagnoses is silent: NEXT_PUBLIC_APP_URL
 * is inlined at build time and falls back to localhost when unset, so password
 * recovery refuses to send and nothing anywhere says why.
 *
 * Everything here is already public — the site's own origin and the path a
 * recovery link returns to. No secret, key, token, cookie or header value is
 * read or emitted, and no environment value is echoed: only whether one is
 * present, and which source won.
 */
// Without this Next prerenders the route at build time and serves a frozen
// snapshot — which would report the very build-time values this endpoint
// exists to distinguish from the runtime ones.
export const dynamic = 'force-dynamic';

export function GET() {
  const origin = appOrigin();

  return NextResponse.json(
    {
      appUrlConfigured: Boolean(process.env.NEXT_PUBLIC_APP_URL),
      vercelProductionUrlPresent: Boolean(process.env.VERCEL_PROJECT_PRODUCTION_URL),
      source: appOriginSource(),
      origin,
      isLoopback: isLoopbackOrigin(origin),
      recoveryRedirectUrl: recoveryRedirectUrl('/reset-password', origin),
      // The guard in requestPasswordResetAction that refuses to send.
      wouldSendRecoveryEmail:
        !(process.env.NODE_ENV === 'production' && isLoopbackOrigin(origin)),
      nodeEnv: process.env.NODE_ENV ?? null,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
