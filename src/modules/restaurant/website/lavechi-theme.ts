import { useEffect, useState } from 'react';

/**
 * The Lavechi design system.
 *
 * Exact tokens, not derived from anything: this is a complete visual
 * identity in its own right, selectable as a `background` theme preset
 * (see THEME_BACKGROUNDS in builder-shared.ts) alongside light/dark/warm.
 * Choosing it means the gold/rust accents below are what render — an
 * organization's own primaryColor/secondaryColor settings do not tint this
 * theme, exactly as they do not tint the existing 'dark' or 'warm' presets.
 *
 * Colors are plain hex/rgba strings rather than CSS custom properties: two
 * of them (the gold button glow, the hairline border) are used as literal
 * string composites (`${gold}33`, an rgba() already carrying its own alpha),
 * which a `var()` reference cannot be suffixed with in plain CSS.
 */
export const LAVECHI = {
  bg: '#07231A',
  bgElev: '#0C3624',
  panel: '#103726',
  panelSoft: '#164A34',
  gold: '#D7DE3E',
  goldSoft: '#E8ED8F',
  cream: '#F4F1E4',
  muted: '#9FB6A6',
  sage: '#8FA07A',
  rust: '#C0623A',
  line: 'rgba(244,241,228,0.11)',
} as const;

/** The splash/landing radial background, applied once at the page root. */
export const LAVECHI_SPLASH_BACKGROUND =
  `radial-gradient(circle at 50% 18%, ${LAVECHI.bgElev}, ${LAVECHI.bg} 60%)`;

/** The card shadow every panel in this theme shares. */
export const LAVECHI_CARD_SHADOW = '0 18px 44px rgba(0,0,0,.2)';

/** Shown only while a gold (primary) button is the active/pressed one. */
export const LAVECHI_GOLD_GLOW = `0 12px 28px ${LAVECHI.gold}33`;

export const LAVECHI_RADIUS = {
  panel: '22px',   // cards/panels: 18–26px
  control: '13px', // primary buttons/inputs: 12–15px
  badge: '999px',
  iconButton: '12px', // back/close: square 36–44px, 11–13px radius
} as const;

function hexToRgbTriplet(hex: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return '215 222 62';
  return `${parseInt(m[1]!, 16)} ${parseInt(m[2]!, 16)} ${parseInt(m[3]!, 16)}`;
}

/**
 * Every platform token (`--lb-*`) re-themed at once, as plain RGB triplets —
 * what lets every `bg-bg` / `border-line` / `bg-elevated` / `text-muted`
 * class already written throughout the storefront pick up this palette with
 * no per-usage class change. Used both by the site builder's `brandStyle()`
 * (scoped to the `/r/<org>` subtree) and directly by the token-scoped
 * `/p/[token]` guest-QR page, which has no site-builder theme of its own to
 * read.
 *
 * `--lb-border` is a pre-blended solid rather than the spec's translucent
 * rgba(): `border-line` is used at full opacity throughout, and a `var()`
 * reference cannot be given a different alpha per call site the way a
 * literal rgba() string could.
 */
export function lavechiCssVars(): Record<string, string> {
  return {
    '--lb-primary': hexToRgbTriplet(LAVECHI.gold),
    '--lb-primary-fg': hexToRgbTriplet(LAVECHI.bg),
    '--lb-primary-soft': hexToRgbTriplet(LAVECHI.goldSoft),
    '--lb-accent': hexToRgbTriplet(LAVECHI.rust),
    '--lb-accent-soft': hexToRgbTriplet(LAVECHI.sage),
    '--lb-bg': hexToRgbTriplet(LAVECHI.bg),
    '--lb-surface': hexToRgbTriplet(LAVECHI.panel),
    '--lb-elevated': hexToRgbTriplet(LAVECHI.panelSoft),
    '--lb-fg': hexToRgbTriplet(LAVECHI.cream),
    '--lb-muted': hexToRgbTriplet(LAVECHI.muted),
    '--lb-border': '41 75 59',
    '--lb-success': '122 196 138',
    '--lb-warn': hexToRgbTriplet(LAVECHI.goldSoft),
    '--lb-danger': hexToRgbTriplet(LAVECHI.rust),
    '--lb-radius-sm': LAVECHI_RADIUS.iconButton,
    '--lb-radius': LAVECHI_RADIUS.control,
    '--lb-radius-lg': LAVECHI_RADIUS.panel,
    '--lb-btn-radius': LAVECHI_RADIUS.control,
    '--brand-primary': hexToRgbTriplet(LAVECHI.gold),
    '--brand-secondary': hexToRgbTriplet(LAVECHI.rust),
    fontFamily: '"Cairo", system-ui, sans-serif',
  };
}

/** Standard easing + duration pair for both CSS transitions and Framer Motion. */
export const LAVECHI_EASE = [0.22, 1, 0.36, 1] as const;
export const LAVECHI_DURATION = { fast: 0.18, standard: 0.28 } as const;

/** The spring every bottom sheet in this theme opens with. */
export const LAVECHI_SHEET_SPRING = { type: 'spring' as const, damping: 30, stiffness: 320 };
export const LAVECHI_SHEET_INITIAL = { y: '100%' };
export const LAVECHI_SHEET_ANIMATE = { y: 0 };
export const LAVECHI_SHEET_EXIT = { y: '100%' };

/**
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
