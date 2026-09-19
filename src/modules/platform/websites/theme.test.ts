import { describe, expect, it } from 'vitest';
import { resolveTheme, themeSources, SYSTEM_DEFAULT_THEME } from './theme';

const CORE = {
  logoUrl: 'https://cdn.example/logo.png',
  displayName: 'لافيشي',
  primaryColor: '#AA0000',
  secondaryColor: '#BB0000',
};

describe('brand identity precedence', () => {
  // website override → organization branding → system default
  it('prefers the website override over everything', () => {
    const t = resolveTheme({ colors: { primary: '#123456' } }, CORE);
    expect(t.colors.primary).toBe('#123456');
  });

  it('falls back to the organization brand', () => {
    const t = resolveTheme(undefined, CORE);
    expect(t.colors.primary).toBe('#AA0000');
    expect(t.colors.secondary).toBe('#BB0000');
  });

  it('falls back to the system default when Core has no brand', () => {
    const t = resolveTheme(undefined, null);
    expect(t).toEqual(SYSTEM_DEFAULT_THEME);
  });

  // Core predates the hex constraint on those columns. A value that is not a
  // hex literal must not reach a style attribute through this path.
  it('ignores a Core colour that is not a hex literal', () => {
    const t = resolveTheme(undefined, { ...CORE, primaryColor: 'red; background:url(x)' });
    expect(t.colors.primary).toBe(SYSTEM_DEFAULT_THEME.colors.primary);
  });

  it('always returns a complete theme', () => {
    const t = resolveTheme({}, null);
    for (const v of Object.values(t.colors)) expect(v).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(t.fonts.body).toBeTruthy();
  });

  it('reports which layer each colour came from', () => {
    const s = themeSources({ colors: { primary: '#123456' } }, CORE);
    expect(s.primary).toBe('website');
    expect(s.secondary).toBe('organization');
    expect(s.background).toBe('default');
  });
});
