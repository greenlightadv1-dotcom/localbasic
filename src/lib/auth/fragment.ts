/**
 * Reading the URL fragment Supabase leaves behind after an email link.
 *
 * Two different flows reach this application:
 *
 *   * PKCE — what the app's own `/forgot-password` starts. Supabase returns a
 *     `?code=` query parameter, `/callback` exchanges it server-side, and the
 *     session lands in httpOnly cookies.
 *
 *   * Implicit — what a link generated from the Supabase Dashboard uses, since
 *     no code verifier exists in the recipient's browser. Supabase returns the
 *     tokens in the URL *fragment*, which browsers never send to a server. No
 *     route handler can see them; only client code can.
 *
 * This parses that fragment so the client can hand the tokens to the server
 * once, over the app's own origin, and both flows end up with the same
 * httpOnly cookie session.
 */
export type AuthFragment =
  | { kind: 'none' }
  /** Supabase reports a dead link here, e.g. error_code=otp_expired. */
  | { kind: 'error'; code: string }
  | { kind: 'session'; accessToken: string; refreshToken: string; type: string };

export function parseAuthFragment(hash: string | null | undefined): AuthFragment {
  if (typeof hash !== 'string') return { kind: 'none' };

  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw.length === 0) return { kind: 'none' };

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return { kind: 'none' };
  }

  const error = params.get('error_code') ?? params.get('error');
  if (error) return { kind: 'error', code: error };

  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (!accessToken || !refreshToken) return { kind: 'none' };

  return {
    kind: 'session',
    accessToken,
    refreshToken,
    type: params.get('type') ?? '',
  };
}

/**
 * Where a link of this kind should land once its session is established.
 *
 * Recovery is the one that must not be sent to the workspace: the whole point
 * of the link is that the person cannot sign in and has to set a password.
 */
export function landingPathForType(type: string): string {
  return type === 'recovery' ? '/reset-password' : '/workspace';
}
