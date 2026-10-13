/**
 * The storefront theme engine.
 *
 * One pure function from a store's two brand colors to the `--lb-*` tokens
 * every component already reads (tailwind.config.ts maps bg-primary, text-fg,
 * border-line and the rest onto them). Apply the result as a style attribute on
 * a wrapper and everything inside re-themes with no per-component change.
 *
 * Which colors a store may use is NOT decided here. The database hands the
 * public pages the EFFECTIVE colors (the store's own on Growth/Scale plans, the
 * LocalBasic defaults on Basic — see migration 0091), and this function only
 * turns them into a palette. Pure and import-free so server and client share it.
 *
 * The look is a light, food-delivery-app palette: white cards on a very lightly
 * tinted ground, the brand color for buttons, badges and active tabs, and
 * generous radii. Anything unparseable falls back to the LocalBasic blue, so a
 * bad value can never reach a style attribute as-is.
 */

export const DEFAULT_PRIMARY = '#1E2FC8';
export const DEFAULT_SECONDARY = '#6B8BFA';

type Rgb = [number, number, number];

export function parseHex(hex: string, fallback: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? '').trim()) ?? /^#?([0-9a-f]{6})$/i.exec(fallback)!;
  const v = parseInt(m[1]!, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Linear blend: t = 0 returns a, t = 1 returns b. */
function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * t)) as Rgb;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance. */
export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
const INK: Rgb = [20, 22, 28];

/**
 * Text on the brand color: white or black, whichever reads better. Against any
 * color one of the two reaches at least 4.58:1, so button and badge text always
 * passes WCAG AA — a near-black ink would not, on mid-tone reds and oranges.
 */
export function readableOn(bg: Rgb): Rgb {
  return contrastRatio(bg, WHITE) >= contrastRatio(bg, BLACK) ? WHITE : BLACK;
}

/** Darkens `color` toward ink until it reaches `min` contrast against `bg`. */
function ensureContrast(color: Rgb, bg: Rgb, min: number): Rgb {
  let c = color;
  for (let i = 0; i < 20 && contrastRatio(c, bg) < min; i += 1) c = mix(c, INK, 0.15);
  return c;
}

const triplet = (c: Rgb) => c.join(' ');

export type ThemeVars = Record<string, string>;

export function brandThemeVars(primaryHex?: string | null, secondaryHex?: string | null): ThemeVars {
  const primary = parseHex(primaryHex ?? DEFAULT_PRIMARY, DEFAULT_PRIMARY);
  const secondary = parseHex(secondaryHex ?? DEFAULT_SECONDARY, DEFAULT_SECONDARY);

  return {
    '--lb-primary': triplet(primary),
    '--lb-primary-fg': triplet(readableOn(primary)),
    '--lb-primary-soft': triplet(mix(primary, WHITE, 0.9)),
    '--lb-accent': triplet(secondary),
    '--lb-accent-soft': triplet(mix(secondary, WHITE, 0.78)),

    '--lb-bg': triplet(WHITE),
    '--lb-surface': triplet(mix(primary, WHITE, 0.965)),
    '--lb-elevated': triplet(WHITE),
    '--lb-fg': triplet(ensureContrast(mix(primary, INK, 0.88), WHITE, 12)),
    '--lb-muted': triplet(ensureContrast(mix(primary, [112, 118, 130], 0.8), WHITE, 4.6)),
    '--lb-border': triplet(mix(primary, [232, 234, 238], 0.86)),

    '--lb-success': '18 122 86',
    '--lb-warn': '180 105 14',
    '--lb-danger': '194 47 61',

    '--lb-radius-sm': '10px',
    '--lb-radius': '14px',
    '--lb-radius-lg': '22px',
    '--lb-btn-radius': '14px',

    '--brand-primary': triplet(primary),
    '--brand-secondary': triplet(secondary),
  };
}

/** Whether two colors are the platform defaults — used to label "default" in the UI. */
export function isDefaultPalette(primaryHex: string, secondaryHex: string): boolean {
  return (
    primaryHex.toLowerCase() === DEFAULT_PRIMARY.toLowerCase() &&
    secondaryHex.toLowerCase() === DEFAULT_SECONDARY.toLowerCase()
  );
}
