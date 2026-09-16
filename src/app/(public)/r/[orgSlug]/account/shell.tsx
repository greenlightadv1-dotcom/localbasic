import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getWebsite, type Website } from '@/modules/restaurant/website/service';
import { currentUser, getProfile, type CustomerProfile } from '@/modules/restaurant/account/service';
import { brandStyle } from '../parts';
import { SignOutButton } from './forms';

/**
 * The customer account shell.
 *
 * It wears the restaurant's own branding, not Local Basic's admin chrome: this
 * is a consumer surface reached from a restaurant's website, and it should feel
 * like part of that restaurant.
 *
 * It deliberately shows no staff or platform navigation. A customer account is
 * not a workspace, and there is nothing here that links to one.
 */

const TABS = [
  { href: '', label: 'حسابي' },
  { href: '/orders', label: 'طلباتي' },
  { href: '/favorites', label: 'المفضلة' },
  { href: '/addresses', label: 'عناويني' },
  { href: '/settings', label: 'الإعدادات' },
] as const;

/**
 * Resolves the restaurant and the signed-in customer, or sends the visitor
 * where they need to go.
 *
 * The published-website gate is the same one D2 uses, so an unpublished or
 * unknown restaurant has no account area either — it is simply not found.
 */
export async function requireCustomer(orgSlug: string): Promise<{
  site: Website;
  profile: CustomerProfile;
}> {
  const site = await getWebsite(orgSlug);
  if (!site) notFound();

  const user = await currentUser();
  if (!user) redirect(`/r/${orgSlug}/account/sign-in`);

  const profile = await getProfile(orgSlug);
  // Authenticated but the profile read came back empty: treat it as no session
  // rather than rendering a half-built account.
  if (!profile) redirect(`/r/${orgSlug}/account/sign-in`);

  return { site, profile };
}

export function AccountShell({
  site,
  orgSlug,
  active,
  title,
  children,
}: {
  site: Website;
  orgSlug: string;
  active: (typeof TABS)[number]['href'];
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={brandStyle(site)} className="min-h-dvh bg-bg">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-3 px-4 py-4 sm:px-6">
          <Link href={`/r/${orgSlug}`} className="font-extrabold text-fg">
            {site.organizationName}
          </Link>
          <span aria-hidden className="text-muted">/</span>
          <span className="text-sm text-muted">حسابي</span>
          <div className="ms-auto">
            <SignOutButton orgSlug={orgSlug} />
          </div>
        </div>

        <nav
          aria-label="أقسام الحساب"
          className="mx-auto flex max-w-3xl gap-1 overflow-x-auto px-4 pb-2 sm:px-6"
        >
          {TABS.map((tab) => {
            const selected = tab.href === active;
            return (
              <Link
                key={tab.href}
                href={`/r/${orgSlug}/account${tab.href}`}
                aria-current={selected ? 'page' : undefined}
                className={
                  'whitespace-nowrap rounded px-3 py-2 text-sm font-medium transition-colors ' +
                  (selected
                    ? 'bg-primary text-primary-fg'
                    : 'text-muted hover:bg-elevated hover:text-fg')
                }
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </header>

      <main className="mx-auto max-w-3xl space-y-5 px-4 py-6 sm:px-6">
        <h1 className="text-xl font-extrabold text-fg">{title}</h1>
        {children}
      </main>
    </div>
  );
}

/** The shell for the sign-in and sign-up pages, which have no tabs yet. */
export function AccountAuthShell({
  site,
  orgSlug,
  children,
}: {
  site: Website;
  orgSlug: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={brandStyle(site)}
      className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-bg px-4 py-10"
    >
      <Link href={`/r/${orgSlug}`} className="text-lg font-extrabold text-fg">
        {site.organizationName}
      </Link>
      <div className="w-full max-w-md">{children}</div>
      <Link href={`/r/${orgSlug}`} className="text-sm text-muted hover:text-fg">
        العودة إلى المطعم
      </Link>
    </div>
  );
}
