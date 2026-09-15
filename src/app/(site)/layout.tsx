import { SiteChrome } from '@/components/patterns/site-chrome';

/**
 * The public marketing site. Deliberately separate from the app shell: these
 * pages are anonymous, indexable, and must not look like a dashboard.
 */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return <SiteChrome>{children}</SiteChrome>;
}
