'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { landingPathForType, parseAuthFragment } from '@/lib/auth/fragment';

/**
 * Catches a Supabase email link that landed on the marketing site.
 *
 * The Dashboard's own "reset password" action has no place to put a path: it
 * redirects to the project's Site URL, which is this origin's root. The tokens
 * arrive in the fragment, so the server rendering this page cannot see them and
 * the visitor just gets the home page — silently, which is the bug this fixes.
 *
 * So the fragment is read here, handed to the server once so it becomes the
 * normal httpOnly cookie session, stripped from the address bar, and the
 * person is sent where the link actually meant to take them. A recovery link
 * goes to /reset-password and never to the workspace.
 *
 * Deliberately no Supabase client: this runs on every marketing page, and a
 * `fetch` keeps that bundle unchanged.
 */
export function RecoveryLinkHandler() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const fragment = parseAuthFragment(window.location.hash);
    if (fragment.kind === 'none') return;

    // Clear the fragment before anything async, so a refresh cannot replay it
    // and the tokens stop being visible in the address bar.
    const url = `${window.location.pathname}${window.location.search}`;
    window.history.replaceState(null, '', url);

    if (fragment.kind === 'error') {
      router.replace('/sign-in?error=link_invalid');
      return;
    }

    setBusy(true);
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch('/callback/token', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            access_token: fragment.accessToken,
            refresh_token: fragment.refreshToken,
          }),
        });
        if (cancelled) return;
        router.replace(
          response.ok ? landingPathForType(fragment.type) : '/sign-in?error=link_invalid',
        );
      } catch {
        if (!cancelled) router.replace('/sign-in?error=link_invalid');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  if (!busy) return null;

  return (
    <div
      role="status"
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface/90 text-sm text-muted"
    >
      جارٍ فتح الرابط…
    </div>
  );
}
