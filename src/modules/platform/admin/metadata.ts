import 'server-only';
import type { Metadata } from 'next';
import { getPlatformContext } from './context';

/**
 * Titles for the admin screens, withheld until the caller is known to be a
 * Platform Admin.
 *
 * Page metadata is resolved independently of the page body, so a static
 * `export const metadata` would put "إدارة المنصة" in the tab title of the
 * not-found page a tenant user gets — telling them the surface exists. This
 * returns the generic not-found title instead unless the caller is an admin.
 *
 * getPlatformContext() is React-cached per request, so the gate and the page
 * body share one lookup; this costs no extra query.
 */
export function adminMetadata(title: string) {
  return async function generateMetadata(): Promise<Metadata> {
    const ctx = await getPlatformContext();
    if (!ctx) return { title: 'الصفحة غير موجودة', robots: { index: false, follow: false } };
    return { title, robots: { index: false, follow: false } };
  };
}
