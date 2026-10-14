'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { buildWhatsAppVerifyUrl } from './whatsapp';
import { useOrderStatusBroadcast } from './use-order-status';
import {
  clearPending, decide, isExpired, loadPending, nextPollDelay, savePending,
  type StorageLike, type VerificationCheck, type VerificationInfo,
} from './pending';

export type PendingVerification = {
  token: string;
  code: string;
  whatsappUrl: string;
  expiresAt: string | null;
};

function storage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The WhatsApp verification step, made to survive the page going away.
 *
 * Four ways the page learns the webhook has confirmed the guest, any of which
 * is enough:
 *   1. the realtime broadcast on the order's own token (instant, when the
 *      socket is alive);
 *   2. a re-check the moment the guest returns to the tab — mobile browsers
 *      drop the socket in the background, and often reload the page when the
 *      guest comes back from WhatsApp;
 *   3. a gentle poll while the sheet is open and the tab is visible (every
 *      5s, every 30s once the code has expired, since the cashier can still
 *      confirm by hand);
 *   4. on load, a saved pending order (token only) is read back from the
 *      server and the sheet restored — or, if it was confirmed meanwhile,
 *      handed straight to the status banner.
 *
 * Every check is one call to the rate-limited, token-scoped status read; at
 * most one is in flight, and automatic ones are spaced out.
 */
export function usePendingVerification({
  scopeKey,
  check,
  onConfirmed,
}: {
  /** Which checkout this is (one store, or one table's QR). */
  scopeKey: string;
  check: (token: string) => Promise<VerificationCheck>;
  /** The order is past verification: clear the cart, show the status banner. */
  onConfirmed: (token: string) => void;
}) {
  const [pending, setPending] = useState<PendingVerification | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const checkRef = useRef(check);
  checkRef.current = check;
  const onConfirmedRef = useRef(onConfirmed);
  onConfirmedRef.current = onConfirmed;
  const inFlight = useRef(false);
  const lastCheckAt = useRef(0);

  const show = useCallback((token: string, code: string, expiresAt: string | null) => {
    savePending(storage(), scopeKey, token);
    setPending({ token, code, whatsappUrl: buildWhatsAppVerifyUrl(code), expiresAt });
  }, [scopeKey]);

  const confirm = useCallback((token: string) => {
    clearPending(storage(), scopeKey);
    setPending(null);
    setError(null);
    onConfirmedRef.current(token);
  }, [scopeKey]);

  const run = useCallback(async (token: string, manual: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    lastCheckAt.current = Date.now();
    if (manual) setChecking(true);
    try {
      const d = decide(await checkRef.current(token));
      if (d.kind === 'pending') {
        show(token, d.code, d.expiresAt);
        setError(null);
      } else if (d.kind === 'confirmed') {
        confirm(token);
      } else if (d.kind === 'gone') {
        clearPending(storage(), scopeKey);
        setPending(null);
      } else if (manual) {
        setError(d.error);
      }
    } catch {
      if (manual) setError('تعذّر التحقق من حالة الطلب.');
    } finally {
      inFlight.current = false;
      if (manual) setChecking(false);
    }
  }, [scopeKey, show, confirm]);

  /**
   * Right after checkout, with the answer the caller already fetched. Returns
   * true when the order is waiting for verification (the sheet takes over).
   */
  const begin = useCallback((token: string, info: VerificationInfo | null): boolean => {
    if (info && info.status === 'pending_verification' && info.code) {
      show(token, info.code, info.expiresAt);
      lastCheckAt.current = Date.now();
      return true;
    }
    return false;
  }, [show]);

  // 4. Restore a pending order saved before a reload.
  useEffect(() => {
    const saved = loadPending(storage(), scopeKey);
    if (saved) void run(saved, false);
  }, [scopeKey, run]);

  // 1. Realtime.
  useOrderStatusBroadcast(pending?.token ?? null, (status) => {
    const current = pendingRef.current;
    if (current && status !== 'pending_verification') confirm(current.token);
  });

  // 2. Returning to the tab (also bfcache restores via pageshow).
  useEffect(() => {
    const onReturn = () => {
      const current = pendingRef.current;
      if (!current || document.visibilityState !== 'visible') return;
      // focus, visibilitychange and pageshow can arrive together; the
      // in-flight lock stops overlap, this stops back-to-back repeats.
      if (Date.now() - lastCheckAt.current < 800) return;
      void run(current.token, false);
    };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    window.addEventListener('pageshow', onReturn);
    return () => {
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
      window.removeEventListener('pageshow', onReturn);
    };
  }, [run]);

  // 3. Gentle poll while waiting and visible.
  useEffect(() => {
    if (!pending) return;
    const tick = window.setInterval(() => {
      const current = pendingRef.current;
      if (!current || document.visibilityState !== 'visible') return;
      if (Date.now() - lastCheckAt.current < nextPollDelay(current.expiresAt)) return;
      void run(current.token, false);
    }, 1_000);
    return () => window.clearInterval(tick);
  }, [pending, run]);

  const recheck = useCallback(() => {
    const current = pendingRef.current;
    if (current) void run(current.token, true);
  }, [run]);

  return {
    pending,
    checking,
    error,
    expired: pending ? isExpired(pending.expiresAt) : false,
    begin,
    recheck,
  };
}
