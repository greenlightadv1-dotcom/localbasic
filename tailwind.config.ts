import type { Config } from 'tailwindcss';

/**
 * Every colour resolves to a CSS variable so an organization's branding can
 * override --lb-primary / --lb-accent at runtime, per request, with no rebuild
 * and no per-tenant stylesheet.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: 'rgb(var(--lb-primary) / <alpha-value>)',
          fg: 'rgb(var(--lb-primary-fg) / <alpha-value>)',
          soft: 'rgb(var(--lb-primary-soft) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--lb-accent) / <alpha-value>)',
          soft: 'rgb(var(--lb-accent-soft) / <alpha-value>)',
        },
        bg: 'rgb(var(--lb-bg) / <alpha-value>)',
        surface: 'rgb(var(--lb-surface) / <alpha-value>)',
        elevated: 'rgb(var(--lb-elevated) / <alpha-value>)',
        fg: 'rgb(var(--lb-fg) / <alpha-value>)',
        muted: 'rgb(var(--lb-muted) / <alpha-value>)',
        line: 'rgb(var(--lb-border) / <alpha-value>)',
        success: 'rgb(var(--lb-success) / <alpha-value>)',
        warn: 'rgb(var(--lb-warn) / <alpha-value>)',
        danger: 'rgb(var(--lb-danger) / <alpha-value>)',
      },
      borderRadius: {
        sm: 'var(--lb-radius-sm)',
        DEFAULT: 'var(--lb-radius)',
        lg: 'var(--lb-radius-lg)',
      },
      fontFamily: {
        sans: ['var(--lb-font-sans)', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px rgb(14 19 48 / 0.04), 0 1px 3px rgb(14 19 48 / 0.06)',
        pop: '0 8px 24px rgb(14 19 48 / 0.10)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
      },
      animation: {
        'fade-in': 'fade-in 140ms ease-out',
        shimmer: 'shimmer 1.4s infinite',
      },
    },
  },
  plugins: [],
};

export default config;
