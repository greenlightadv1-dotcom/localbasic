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
        // The Lavechi theme's display face — brand name, screen titles, order
        // codes, item-sheet titles. Body text, prices and buttons stay on
        // Cairo (the `sans` family above), which already loads platform-wide.
        reem: ['"Reem Kufi"', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px rgb(14 19 48 / 0.04), 0 1px 3px rgb(14 19 48 / 0.06)',
        pop: '0 8px 24px rgb(14 19 48 / 0.10)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        // Sheets and bars rise into place; the add button pops when a count changes.
        'sheet-up': { from: { transform: 'translateY(100%)' }, to: { transform: 'translateY(0)' } },
        'slide-down': { from: { opacity: '0', transform: 'translateY(-12px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        pop: { '0%': { transform: 'scale(1)' }, '40%': { transform: 'scale(1.3)' }, '100%': { transform: 'scale(1)' } },
        // The splash logo hops, then squashes as it lands.
        'bounce-soft': {
          '0%, 100%': { transform: 'translateY(0) scale(1, 1)' },
          '45%': { transform: 'translateY(-26px) scale(0.97, 1.04)' },
          '70%': { transform: 'translateY(0) scale(1.06, 0.93)' },
          '85%': { transform: 'translateY(-5px) scale(1, 1)' },
        },
        'shadow-squash': {
          '0%, 100%': { transform: 'scaleX(1)', opacity: '0.28' },
          '45%': { transform: 'scaleX(0.6)', opacity: '0.12' },
          '70%': { transform: 'scaleX(1.12)', opacity: '0.34' },
        },
        'fade-up': { from: { opacity: '0', transform: 'translateY(14px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
      },
      animation: {
        'fade-in': 'fade-in 140ms ease-out',
        shimmer: 'shimmer 1.4s infinite',
        'sheet-up': 'sheet-up 300ms cubic-bezier(0.22, 1, 0.36, 1)',
        'slide-down': 'slide-down 220ms ease-out',
        pop: 'pop 260ms ease-out',
        'bounce-soft': 'bounce-soft 1.5s ease-in-out infinite',
        'shadow-squash': 'shadow-squash 1.5s ease-in-out infinite',
        'fade-up': 'fade-up 600ms ease-out both',
      },
    },
  },
  plugins: [],
};

export default config;
