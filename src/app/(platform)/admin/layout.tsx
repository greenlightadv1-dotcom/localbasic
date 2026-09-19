import Link from 'next/link';
import { Logo } from '@/components/brand/logo';
import { requirePlatformAdmin } from '@/modules/platform/admin/context';

export const dynamic = 'force-dynamic';
// No metadata export here on purpose: a layout title template is applied to
// every child, including the not-found page an unauthorized visitor receives.
// Each page supplies its own title through adminMetadata(), which withholds it
// until the caller is known to be an admin.

const NAV = [
  { href: '/admin', label: 'لوحة المنصة' },
  { href: '/admin/customers', label: 'العملاء' },
  { href: '/admin/onboard', label: 'عميل جديد' },
  { href: '/admin/websites', label: 'المواقع' },
  { href: '/admin/leads', label: 'العملاء المحتملون' },
  { href: '/admin/subscriptions', label: 'الاشتراكات' },
  { href: '/admin/plans', label: 'الباقات' },
  { href: '/admin/services', label: 'الخدمات' },
  { href: '/admin/promo-codes', label: 'أكواد الخصم' },
  { href: '/admin/audit', label: 'سجل المنصة' },
  { href: '/admin/team', label: 'فريق المنصة' },
];

/**
 * Platform Admin shell.
 *
 * Every page under it is gated here as well as in the database. The gate
 * returns 404 rather than 403, so a tenant user probing /admin cannot tell the
 * surface exists.
 */
export default async function PlatformAdminLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requirePlatformAdmin();

  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      {/* Visually distinct from any tenant workspace: this is the operator's
          console, and confusing the two would be dangerous. */}
      <header className="border-b border-line bg-fg text-white">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6">
          <Link href="/admin" className="flex items-center gap-2">
            <Logo variant="mark" className="h-7 w-7" />
            <span className="text-sm font-bold">إدارة المنصة</span>
          </Link>
          <nav className="ms-auto flex gap-1 overflow-x-auto">
            {NAV.map((i) => (
              <Link
                key={i.href}
                href={i.href}
                className="whitespace-nowrap rounded px-3 py-1.5 text-sm font-medium text-white/70 transition-colors hover:bg-white/10 hover:text-white"
              >
                {i.label}
              </Link>
            ))}
          </nav>
          <span className="hidden shrink-0 text-xs text-white/60 sm:block">
            {ctx.user.fullName ?? ctx.user.email} · {ctx.role === 'owner' ? 'مالك المنصة' : 'موظف'}
          </span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
