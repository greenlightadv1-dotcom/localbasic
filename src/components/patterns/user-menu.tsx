'use client';

import { useState } from 'react';
import { LogOut, UserCircle2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { signOutAction } from '@/app/(auth)/actions';

const ROLE_NAMES: Record<string, string> = {
  owner: 'المالك',
  admin: 'مدير النظام',
  manager: 'مدير فرع',
  accountant: 'محاسب',
  cashier: 'كاشير',
  kitchen: 'المطبخ',
  waiter: 'كابتن',
  staff: 'موظف',
};

export function UserMenu({
  organizationName,
  roleKeys,
  isOwner,
  fullName,
}: {
  organizationName: string;
  roleKeys: string[];
  isOwner: boolean;
  fullName: string | null;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-surface"
      >
        <UserCircle2 className="h-6 w-6 text-muted" aria-hidden="true" />
        <span className="hidden sm:inline">
          {fullName ?? (isOwner ? 'المالك' : (roleKeys[0] && ROLE_NAMES[roleKeys[0]]) || 'عضو')}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute end-0 top-full z-30 mt-2 w-56 animate-fade-in rounded border border-line bg-elevated p-2 shadow-pop"
        >
          <div className="border-b border-line px-2 pb-2">
            <p className="truncate text-sm font-semibold">{organizationName}</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {isOwner && <Badge tone="info">مالك</Badge>}
              {roleKeys.map((r) => (
                <Badge key={r}>{ROLE_NAMES[r] ?? r}</Badge>
              ))}
            </div>
          </div>
          <form action={signOutAction}>
            <button
              type="submit"
              role="menuitem"
              className="mt-1 flex w-full items-center gap-2 rounded px-2 py-2 text-sm text-danger hover:bg-danger/10"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              تسجيل الخروج
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
