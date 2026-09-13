import Link from 'next/link';
import { resolveTenantContext } from '@/modules/core/tenancy/context';
import { SETTINGS_NAVIGATION } from '@/config/modules';
import { PageHeader } from '@/components/patterns/page-header';

export default async function SettingsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  const base = `/${ctx.organizationSlug}/${ctx.branchSlug}`;
  const allowed = SETTINGS_NAVIGATION.filter((item) => ctx.permissions.has(item.permission));

  return (
    <div className="space-y-5">
      <PageHeader title="الإعدادات" description={ctx.organizationName} />
      <nav aria-label="أقسام الإعدادات" className="flex flex-wrap gap-2">
        {allowed.map((item) => (
          <Link
            key={item.href}
            href={`${base}${item.href}`}
            className="rounded border border-line bg-elevated px-3 py-1.5 text-sm text-muted hover:bg-surface hover:text-primary"
          >
            {item.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
