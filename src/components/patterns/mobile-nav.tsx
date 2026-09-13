'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as Icons from 'lucide-react';
import { cn } from '@/lib/cn';
import type { NavItem } from '@/config/modules';

/** Bottom navigation for phones and tablets. Large targets, no hover states. */
export function MobileNav({ items, base }: { items: NavItem[]; base: string }) {
  const pathname = usePathname();

  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-elevated lg:hidden">
      <ul className="flex">
        {items.map((item) => {
          const href = `${base}${item.href}`;
          const active = pathname === href;
          const Icon =
            (Icons as unknown as Record<string, React.ComponentType<{ className?: string }>>)[
              item.icon
            ] ?? Icons.Circle;
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-h-14 flex-col items-center justify-center gap-1 py-2 text-[11px] font-medium',
                  active ? 'text-primary' : 'text-muted',
                )}
              >
                <Icon className="h-5 w-5" aria-hidden="true" />
                <span className="truncate px-1">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
