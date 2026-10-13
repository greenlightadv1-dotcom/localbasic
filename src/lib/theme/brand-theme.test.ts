import { describe, expect, it } from 'vitest';
import {
  brandThemeVars, contrastRatio, DEFAULT_PRIMARY, DEFAULT_SECONDARY, parseHex, readableOn,
} from './brand-theme';

const rgb = (v: string) => v.split(' ').map(Number) as [number, number, number];

describe('brandThemeVars', () => {
  it('turns the brand colors into the platform tokens', () => {
    const v = brandThemeVars('#024323', '#D7DE3E');
    expect(v['--lb-primary']).toBe('2 67 35');
    expect(v['--lb-accent']).toBe('215 222 62');
    for (const k of ['--lb-bg', '--lb-surface', '--lb-fg', '--lb-muted', '--lb-border', '--lb-primary-soft']) {
      expect(v[k]).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/);
    }
  });

  it('falls back to the LocalBasic palette for missing or malformed colors', () => {
    const fallback = brandThemeVars(DEFAULT_PRIMARY, DEFAULT_SECONDARY);
    expect(brandThemeVars(null, undefined)).toEqual(fallback);
    expect(brandThemeVars('red; background:url(x)', '#12')).toEqual(fallback);
    expect(brandThemeVars('<script>', '')).toEqual(fallback);
  });

  it('keeps text readable on the brand color, dark or light', () => {
    for (const hex of ['#024323', '#1E2FC8', '#D7DE3E', '#FFD400', '#E63946', '#FFFFFF', '#000000']) {
      const v = brandThemeVars(hex, null);
      expect(contrastRatio(rgb(v['--lb-primary']!), rgb(v['--lb-primary-fg']!))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('puts light text on a deep brand and dark text on a pale one', () => {
    expect(readableOn(parseHex('#024323', DEFAULT_PRIMARY))).toEqual([255, 255, 255]);
    expect(readableOn(parseHex('#FFE96B', DEFAULT_PRIMARY))).toEqual([0, 0, 0]);
  });

  it('keeps body text strongly legible on the page ground', () => {
    const v = brandThemeVars('#FF6B00', '#FFB100');
    expect(contrastRatio(rgb(v['--lb-fg']!), rgb(v['--lb-bg']!))).toBeGreaterThan(12);
    expect(contrastRatio(rgb(v['--lb-muted']!), rgb(v['--lb-bg']!))).toBeGreaterThanOrEqual(4.5);
  });
});
