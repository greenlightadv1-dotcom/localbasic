import type { Metadata, Viewport } from 'next';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: { default: 'LocalBasic', template: '%s · LocalBasic' },
  description: 'منصة إدارة الأعمال المحلية — مدعوم بواسطة Green Light',
  // The marketing pages under (site) opt themselves back in. Everything else —
  // every workspace, kitchen and QR screen — stays out of search results.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#1E2FC8',
};

/**
 * Arabic + RTL is the default, with `lang`/`dir` set from the root. The entire
 * UI is built with logical properties (ms-/me-/ps-/pe-, start/end) so adding
 * English later is a matter of flipping these two attributes, not restyling.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700;800&family=Reem+Kufi:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
