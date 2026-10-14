'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';

/**
 * A small, self-contained toast for the guest pages (they have no app-level
 * provider). Anything can call showStoreToast(); the one <StoreToaster />
 * mounted on the page displays it near the top, clear of the bottom nav.
 */
const EVENT = 'lb-store-toast';

export type StoreToast = { message: string; actionLabel?: string; onAction?: () => void };

export function showStoreToast(toast: StoreToast) {
  window.dispatchEvent(new CustomEvent<StoreToast>(EVENT, { detail: toast }));
}

export function StoreToaster() {
  const [toast, setToast] = useState<(StoreToast & { id: number }) | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    function on(e: Event) {
      const detail = (e as CustomEvent<StoreToast>).detail;
      setToast({ ...detail, id: Date.now() });
      clearTimeout(timer);
      timer = setTimeout(() => setToast(null), 3500);
    }
    window.addEventListener(EVENT, on);
    return () => {
      window.removeEventListener(EVENT, on);
      clearTimeout(timer);
    };
  }, []);

  if (!toast) return null;
  return (
    <div
      key={toast.id}
      role="status"
      aria-live="polite"
      data-testid="store-toast"
      className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex justify-center px-4"
    >
      <div className="pointer-events-auto flex max-w-md animate-slide-down items-center gap-2.5 rounded-full bg-fg py-2.5 ps-4 pe-2.5 text-sm font-semibold text-bg shadow-[0_10px_30px_rgba(0,0,0,.3)]">
        <CheckCircle2 className="h-5 w-5 shrink-0 text-success" aria-hidden="true" />
        <span className="min-w-0 flex-1">{toast.message}</span>
        {toast.onAction ? (
          <button
            type="button"
            onClick={() => { toast.onAction?.(); setToast(null); }}
            className="shrink-0 rounded-full bg-bg px-3 py-1.5 text-xs font-extrabold text-fg active:scale-95"
          >
            {toast.actionLabel ?? 'عرض'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
