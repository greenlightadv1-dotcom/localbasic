import type { SiteTheme } from './definition';

/**
 * Brand identity resolution.
 *
 * A website's look comes from three places, and the order between them is the
 * whole point of this file:
 *
 *   website override  →  organization branding  →  system default
 *
 * The organization already has a brand in `branding_settings` — logo, display
 * name, primary and secondary colour — set when the customer was onboarded.
 * Duplicating it into every website would give the platform two answers to
 * "what colour is this customer", and they would drift. So the website stores
 * only what it changes, and everything else is resolved from Core at read time.
 */

export type OrganizationBranding = {
  logoUrl: string | null;
  displayName: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
};

/** The floor. Every field is present, so resolution can never produce a gap. */
export const SYSTEM_DEFAULT_THEME: SiteTheme = {
  colors: {
    primary: '#1E2FC8',
    secondary: '#6B8BFA',
    accent: '#1E2FC8',
    background: '#FFFFFF',
    text: '#111827',
  },
  fonts: { heading: 'cairo', body: 'cairo' },
  radius: 'medium',
  style: 'minimal',
};

/** What the website itself overrides. Every field optional by construction. */
export type ThemeOverride = {
  colors?: Partial<SiteTheme['colors']>;
  fonts?: Partial<SiteTheme['fonts']>;
  radius?: SiteTheme['radius'];
  style?: SiteTheme['style'];
};

/**
 * Resolve the three layers into one complete theme.
 *
 * Only a hex colour is taken from Core branding: those columns are constrained
 * to hex in the database, and accepting anything else here would let a value
 * that predates that constraint reach a style attribute.
 */
export function resolveTheme(
  override: ThemeOverride | undefined,
  branding: OrganizationBranding | null,
): SiteTheme {
  const hex = (v: string | null | undefined): string | undefined =>
    v && /^#[0-9A-Fa-f]{6}$/.test(v) ? v : undefined;

  return {
    colors: {
      primary:
        override?.colors?.primary
        ?? hex(branding?.primaryColor)
        ?? SYSTEM_DEFAULT_THEME.colors.primary,
      secondary:
        override?.colors?.secondary
        ?? hex(branding?.secondaryColor)
        ?? SYSTEM_DEFAULT_THEME.colors.secondary,
      // Core has no accent; it follows the primary unless the website says
      // otherwise, which keeps a two-colour brand looking deliberate.
      accent:
        override?.colors?.accent
        ?? hex(branding?.primaryColor)
        ?? SYSTEM_DEFAULT_THEME.colors.accent,
      background: override?.colors?.background ?? SYSTEM_DEFAULT_THEME.colors.background,
      text: override?.colors?.text ?? SYSTEM_DEFAULT_THEME.colors.text,
    },
    fonts: {
      heading: override?.fonts?.heading ?? SYSTEM_DEFAULT_THEME.fonts.heading,
      body: override?.fonts?.body ?? SYSTEM_DEFAULT_THEME.fonts.body,
    },
    radius: override?.radius ?? SYSTEM_DEFAULT_THEME.radius,
    style: override?.style ?? SYSTEM_DEFAULT_THEME.style,
  };
}

/** Which layer each colour actually came from, for the editor to show. */
export function themeSources(
  override: ThemeOverride | undefined,
  branding: OrganizationBranding | null,
): Record<keyof SiteTheme['colors'], 'website' | 'organization' | 'default'> {
  const from = (
    own: string | undefined,
    core: string | null | undefined,
  ): 'website' | 'organization' | 'default' => {
    if (own) return 'website';
    if (core && /^#[0-9A-Fa-f]{6}$/.test(core)) return 'organization';
    return 'default';
  };

  return {
    primary: from(override?.colors?.primary, branding?.primaryColor),
    secondary: from(override?.colors?.secondary, branding?.secondaryColor),
    accent: from(override?.colors?.accent, branding?.primaryColor),
    background: from(override?.colors?.background, null),
    text: from(override?.colors?.text, null),
  };
}
