/**
 * Colour helpers. Pure, with no imports — deliberately.
 *
 * This used to live in modules/core/branding/service.ts, which carries
 * `import 'server-only'`. Anything needing to turn a hex colour into CSS
 * variables therefore dragged the Supabase server client in behind it, which
 * is wrong for a presentational component and would break outright the first
 * time one ran on the client.
 */

/**
 * `#rrggbb` → the `R G B` channel triple Tailwind's `rgb(var(--x) / <alpha>)`
 * syntax expects.
 *
 * Falls back to the brand blue for anything unparseable, so a malformed or
 * hostile value can never reach a style attribute as-is.
 */
export function hexToRgbChannels(hex: string): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return '30 47 200';
  const value = parseInt(match[1]!, 16);
  return `${(value >> 16) & 255} ${(value >> 8) & 255} ${value & 255}`;
}
