'use client';

import { useEffect, useState } from 'react';

/**
 * The one piece of the Lavechi design system that needs the browser.
 *
 * Split out of ./lavechi-theme.ts so that file can stay hook-free and safe
 * to import from Server Components — see its own docstring for why mixing
 * this hook into that module broke every server-side caller of
 * lavechiCssVars().
 *
 * Respects the platform preference both ways: Framer Motion is told to skip
 * straight to the end state, and any hand-written CSS animation this hook
 * gates (the logo's ring pulse, the steam wisps) can be turned off the same
 * way `prefers-reduced-motion` already turns off the CSS `animation` a
 * `@media` query would.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}
