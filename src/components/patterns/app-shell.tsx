import Link from 'next/link';
import * as Icons from 'lucide-react';
import { Logo, PoweredBy } from '@/components/brand/logo';
import { cn } from '@/lib/cn';
import { coreNavigationFor, SETTINGS_NAVIGATION, getModule, type NavItem } from '@/config/modules';
import type { TenantContext } from '@/modules/core/tenancy/context';
import { hexToRgbChannels, type Branding } from '@/modules/core/branding/service';
import { BranchSwitcher } from './branch-switcher';
import { UserMenu } from './user-menu';
import { MobileNav } from './mobile-nav';

function iconFor(name: string) {
  const Icon = (Icons as unknown as Record<string, React.ComponentType<{ className?: string }>>)[name];
  return Icon ?? Icons.Circle;
}

function NavLink({ item, base }: { item: NavItem; base: string }) {
  const Icon = iconFor(item.icon);
  return (
    <Link
      href={`${base}${item.href}`}
      className={cn(
        'flex items-center gap-3 rounded px-3 py-2 text-sm font-medium text-muted',
        'transition-colors hover:bg-primary-soft hover:text-primary',
      )}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

/**
 * The workspace shell: sidebar on desktop, bottom navigation on mobile.
 *
 * Navigation is assembled from the module registry and filtered by the
 * permissions already resolved in the tenant context — so a Storekeeper simply
 * never sees the treasury link. That is a usability decision; the service layer
 * and RLS are what actually stop them reaching it.
 */
export function AppShell({
  ctx,
  branding,
  children,
}: {
  ctx: TenantContext;
  branding: Branding;
  children: React.ReactNode;
}) {
  const base = `/${ctx.organizationSlug}/${ctx.branchSlug}`;
  const allowed = (items: NavItem[]) => items.filter((i) => ctx.permissions.has(i.permission));

  const coreNav = allowed(coreNavigationFor(ctx.enabledModules));
  const settingsNav = allowed(SETTINGS_NAVIGATION);
  const moduleNavs = ctx.enabledModules
    .map((key) => getModule(key))
    .filter((m): m is NonNullable<typeof m> => Boolean(m))
    .map((m) => ({ module: m, items: allowed(m.navigation) }))
    .filter((m) => m.items.length > 0);

  return (
    <div
      className="min-h-dvh"
      // Per-organization branding, applied as a scoped variable override. One
      // inline style block, no rebuild, no per-tenant stylesheet.
      style={
        {
          '--lb-primary': hexToRgbChannels(branding.primaryColor),
          '--lb-accent': hexToRgbChannels(branding.secondaryColor),
        } as React.CSSProperties
      }
    >
      <div className="flex min-h-dvh">
        <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-e border-line bg-elevated lg:flex">
          <div className="flex h-16 items-center gap-2 border-b border-line px-4">
            <Logo variant="mark" className="h-8 w-8" />
            <div className="min-w-0">
              <p className="truncate text-sm font-bold">{branding.displayName}</p>
              <p className="truncate text-xs text-muted">{ctx.branchName}</p>
            </div>
          </div>

          <nav className="flex-1 space-y-6 overflow-y-auto p-3">
            <div className="space-y-0.5">{coreNav.map((i) => <NavLink key={i.href} item={i} base={base} />)}</div>

            {moduleNavs.map(({ module, items }) => (
              <div key={module.key} className="space-y-0.5">
                <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted/70">
                  {module.nameAr}
                </p>
                {items.map((i) => <NavLink key={i.href} item={i} base={base} />)}
              </div>
            ))}

            {settingsNav.length > 0 && (
              <div className="space-y-0.5">
                <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted/70">
                  الإعدادات
                </p>
                {settingsNav.map((i) => <NavLink key={i.href} item={i} base={base} />)}
              </div>
            )}
          </nav>

          {!branding.whiteLabel && (
            <div className="border-t border-line p-4">
              <PoweredBy />
            </div>
          )}
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-3 border-b border-line bg-elevated/95 px-4 backdrop-blur">
            <div className="flex items-center gap-3 lg:hidden">
              <Logo variant="mark" className="h-8 w-8" />
            </div>
            <BranchSwitcher
              branches={ctx.branches}
              currentBranchId={ctx.branchId}
              organizationSlug={ctx.organizationSlug}
            />
            <UserMenu
              organizationName={branding.displayName}
              roleKeys={ctx.roleKeys}
              isOwner={ctx.isOwner}
            />
          </header>

          <main className="flex-1 p-4 pb-24 lg:p-6 lg:pb-6">{children}</main>
        </div>
      </div>

      <MobileNav items={[...coreNav, ...moduleNavs.flatMap((m) => m.items)].slice(0, 5)} base={base} />
    </div>
  );
}
