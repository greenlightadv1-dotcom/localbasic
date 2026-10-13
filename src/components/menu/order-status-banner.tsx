'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { X } from 'lucide-react';
import { useOrderStatusBroadcast } from '@/modules/restaurant/guest-verification/use-order-status';
import { cn } from '@/lib/cn';

/**
 * The guest's live order status, as a slim banner pinned to the top of the
 * menu — placing an order no longer takes the guest to a separate page, so
 * they can keep browsing (or add to a second order) while it is made.
 *
 * The order's tracking token is remembered per store (localStorage), so the
 * banner survives a reload and reappears on the next visit while the order is
 * still open. Status comes from the same capability-token broadcast channel
 * the tracking page uses, with a slow re-read as a safety net for a missed
 * message. "تفاصيل" still opens the full tracking page (items, the edit
 * window) for anyone who wants it.
 */
const EVENT = 'lb-active-order';
const POLL_MS = 20_000;

const storageKey = (scopeKey: string) => `lb-active-order:${scopeKey}`;

/** Called by the checkout the moment an order exists. */
export function rememberActiveOrder(scopeKey: string, token: string) {
  try {
    localStorage.setItem(storageKey(scopeKey), token);
  } catch {
    // Blocked storage: the banner still shows for this page view via the event.
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { scopeKey, token } }));
}

const STAGES = ['received', 'preparing', 'ready', 'completed'] as const;

function describe(status: string): { stage: number; label: string; tone: 'info' | 'warn' | 'success' | 'danger' } {
  switch (status) {
    case 'pending_verification':
      return { stage: -1, label: 'بانتظار تأكيد رقمك عبر واتساب', tone: 'warn' };
    case 'new':
    case 'confirmed':
      return { stage: 0, label: 'تم استلام طلبك', tone: 'info' };
    case 'preparing':
      return { stage: 1, label: 'المطبخ يجهز طلبك', tone: 'info' };
    case 'ready':
    case 'served':
      return { stage: 2, label: 'طلبك جاهز', tone: 'success' };
    case 'completed':
      return { stage: 3, label: 'تم تسليم طلبك — بالهناء والشفاء', tone: 'success' };
    case 'cancelled':
      return { stage: -1, label: 'تم إلغاء الطلب', tone: 'danger' };
    default:
      return { stage: 0, label: 'جارٍ تحديث حالة الطلب', tone: 'info' };
  }
}

export function OrderStatusBanner({
  scopeKey,
  loadStatus,
}: {
  scopeKey: string;
  /** Reads the order's current status by token; null when it cannot be read. */
  loadStatus: (token: string) => Promise<string | null>;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    try {
      setToken(localStorage.getItem(storageKey(scopeKey)));
    } catch {
      // No storage: nothing to restore.
    }
    function onRemember(e: Event) {
      const d = (e as CustomEvent<{ scopeKey: string; token: string }>).detail;
      if (d.scopeKey === scopeKey) {
        setStatus(null);
        setToken(d.token);
      }
    }
    window.addEventListener(EVENT, onRemember);
    return () => window.removeEventListener(EVENT, onRemember);
  }, [scopeKey]);

  const dismiss = useCallback(() => {
    try {
      localStorage.removeItem(storageKey(scopeKey));
    } catch {
      // ignore
    }
    setToken(null);
    setStatus(null);
  }, [scopeKey]);

  const refresh = useCallback(async () => {
    if (!token) return;
    const next = await loadStatus(token);
    if (next === null) {
      // The order no longer resolves (revoked / expired): drop the banner.
      dismiss();
      return;
    }
    setStatus(next);
  }, [token, loadStatus, dismiss]);

  useEffect(() => {
    if (!token) return;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [token, refresh]);

  useOrderStatusBroadcast(token, (next) => setStatus(next));

  if (!token || !status) return null;
  const view = describe(status);
  const finished = status === 'completed' || status === 'cancelled';

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="order-status-banner"
      className={cn(
        'sticky top-0 z-30 border-b px-4 py-2 text-sm backdrop-blur',
        view.tone === 'danger'
          ? 'border-danger/30 bg-danger/10 text-danger'
          : view.tone === 'warn'
            ? 'border-warn/30 bg-warn/10 text-fg'
            : 'border-line bg-elevated/95 text-fg',
      )}
    >
      <div className="mx-auto flex max-w-2xl items-center gap-3">
        <p className="min-w-0 flex-1 truncate font-semibold">{view.label}</p>
        <Link
          href={`/order/track/${token}`}
          className="shrink-0 text-xs font-semibold text-primary underline underline-offset-2"
        >
          تفاصيل
        </Link>
        {finished ? (
          <button type="button" onClick={dismiss} aria-label="إغلاق" className="shrink-0 text-muted">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {view.stage >= 0 ? (
        <ol className="mx-auto mt-1.5 flex max-w-2xl gap-1" aria-hidden="true">
          {STAGES.map((s, i) => (
            <li
              key={s}
              className={cn('h-1 flex-1 rounded-full transition-colors', i <= view.stage ? 'bg-primary' : 'bg-line')}
            />
          ))}
        </ol>
      ) : null}
    </div>
  );
}
