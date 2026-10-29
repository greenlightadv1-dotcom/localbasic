'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowLeft, ChevronDown, Stethoscope, Store, UtensilsCrossed, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { SITE_NAV, type SiteNavItem } from '@/config/site';

const SERVICE_ICON: Record<string, { icon: LucideIcon; tile: string }> = {
  restaurant: { icon: UtensilsCrossed, tile: 'bg-orange-500/10 text-orange-700 dark:text-orange-300' },
  retail: { icon: Store, tile: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
  clinic: { icon: Stethoscope, tile: 'bg-sky-500/10 text-sky-700 dark:text-sky-300' },
};

function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

const LINK = 'rounded px-3 py-2 text-sm font-medium transition-colors hover:bg-surface hover:text-fg';

/**
 * The marketing header's links. A group (the services) opens as a dropdown
 * on desktop — by click or keyboard, closing on Escape, an outside click or
 * navigation — and lays out inline on the phone strip, where a dropdown
 * would be one more tap for no gain.
 */
export function SiteDesktopNav() {
  const pathname = usePathname() ?? '/';
  return (
    <nav aria-label="الرئيسية" className="hidden flex-1 items-center justify-center gap-1 lg:flex">
      {SITE_NAV.map((item) =>
        item.children ? (
          <ServicesMenu key={item.href} item={item} pathname={pathname} />
        ) : (
          <Link key={item.href} href={item.href} aria-current={isActive(pathname, item.href) ? 'page' : undefined}
            className={cn(LINK, isActive(pathname, item.href) ? 'text-fg' : 'text-muted')}>
            {item.label}
          </Link>
        ),
      )}
    </nav>
  );
}

function ServicesMenu({ item, pathname }: { item: SiteNavItem; pathname: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const active = isActive(pathname, item.href);

  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); buttonRef.current?.focus(); } };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button ref={buttonRef} type="button" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen((o) => !o)}
        className={cn(LINK, 'inline-flex items-center gap-1', active || open ? 'text-fg' : 'text-muted')}>
        {item.label}
        <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>
      {open && (
        <div id={menuId}
          className="absolute left-1/2 top-full z-50 mt-2 w-[22rem] -translate-x-1/2 animate-slide-down rounded-lg border border-line bg-elevated p-2 shadow-pop">
          <ul>
            {item.children!.map((c) => {
              const meta = SERVICE_ICON[c.key];
              const Icon = meta?.icon ?? Store;
              const here = isActive(pathname, c.href);
              return (
                <li key={c.href}>
                  <Link href={c.href} aria-current={here ? 'page' : undefined} onClick={() => setOpen(false)}
                    className={cn('flex items-start gap-3 rounded p-3 transition-colors hover:bg-surface', here && 'bg-surface')}>
                    <span className={cn('inline-flex h-10 w-10 shrink-0 items-center justify-center rounded', meta?.tile)}>
                      <Icon className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-bold text-fg">{c.label}</span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-muted">{c.description}</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          <Link href={item.href} onClick={() => setOpen(false)}
            className="mt-1 flex items-center justify-between rounded border-t border-line px-3 pb-1 pt-3 text-sm font-semibold text-primary hover:underline">
            كل الخدمات <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      )}
    </div>
  );
}

export function SiteMobileNav() {
  const pathname = usePathname() ?? '/';
  const navRef = useRef<HTMLElement>(null);
  // The strip scrolls sideways: bring the current page's link into view.
  useEffect(() => {
    const strip = navRef.current;
    const current = strip?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!strip || !current) return;
    const delta = current.offsetLeft + current.offsetWidth / 2 - (strip.scrollLeft + strip.clientWidth / 2);
    strip.scrollBy({ left: delta });
  }, [pathname]);
  const links = SITE_NAV.flatMap((item) => [
    { href: item.href, label: item.label, child: false },
    ...(item.children ?? []).map((c) => ({ href: c.href, label: c.label, child: true })),
  ]);
  return (
    <nav ref={navRef} aria-label="الرئيسية" className="flex gap-1 overflow-x-auto border-t border-line/60 px-4 py-2 lg:hidden">
      {links.map((l) => {
        // "الخدمات" is only current on /services itself; a sector page lights up its own link.
        const here = l.href === '/services' ? pathname === '/services' : isActive(pathname, l.href);
        return (
          <Link key={l.href} href={l.href} aria-current={here ? 'page' : undefined}
            className={cn('whitespace-nowrap rounded px-3 py-1.5 text-sm font-medium transition-colors hover:bg-surface hover:text-fg',
              here ? 'bg-surface text-fg' : 'text-muted', l.child && 'text-[13px]')}>
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
