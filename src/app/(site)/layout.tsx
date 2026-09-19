import { SiteChrome } from '@/components/patterns/site-chrome';
import { RecoveryLinkHandler } from './recovery-link-handler';

/**
 * The public marketing site. Deliberately separate from the app shell: these
 * pages are anonymous, indexable, and must not look like a dashboard.
 *
 * It also carries RecoveryLinkHandler, because this origin's root is the
 * Supabase Site URL — where a Dashboard-generated recovery or magic link lands
 * with its tokens in the fragment. Without it those links quietly show the
 * marketing page instead of signing the person in.
 */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <RecoveryLinkHandler />
      <SiteChrome>{children}</SiteChrome>
    </>
  );
}
