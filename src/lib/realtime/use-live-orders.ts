'use client';

import { useEffect, useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

export const LIVE_ORDERS_POLL_MS = 5_000;

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
/** A burst of row changes (an order plus its lines) collapses into one refetch. */
const EVENT_DEBOUNCE_MS = 250;

/**
 * Keeps a server-rendered orders screen live: the cashier till, the kitchen and
 * bar boards and the orders list.
 *
 * Two independent paths, so neither has to be perfect:
 *
 *   1. Realtime — a postgres_changes subscription on this branch's
 *      restaurant_orders rows gives an instant refresh. The channel is rebuilt
 *      with backoff whenever it errors, times out or closes (a laptop waking
 *      up, a tablet changing networks), instead of staying silently dead.
 *   2. Polling — a 5-second refresh that catches whatever Realtime missed
 *      (RLS hiding an event, a dropped socket not yet noticed, a table not in
 *      the publication).
 *
 * WHY THIS DOES NOT DISTURB WHAT THE USER IS DOING. The refresh is
 * router.refresh() inside a transition: Next fetches the new server-component
 * payload in the background and swaps it in when it is ready, keeping the
 * current screen on display meanwhile. Client component state — open modals,
 * half-typed amounts, the cart, a selected table — lives in the client tree,
 * which a refresh reconciles rather than remounts, so it survives. Nothing here
 * ever navigates or reloads. Further:
 *   - only one refresh is in flight at a time (a slow network cannot stack up);
 *   - nothing runs while the tab is hidden, and one refresh runs the moment it
 *     is visible or back online again.
 */
export function useLiveOrders(branchId: string, scope: string, intervalMs = LIVE_ORDERS_POLL_MS) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // The effect below must not re-subscribe on every render, but it must read
  // the current pending state; a ref bridges the two.
  const pendingRef = useRef(false);
  pendingRef.current = isPending;
  const routerRef = useRef(router);
  routerRef.current = router;

  useEffect(() => {
    let disposed = false;
    let channel: ReturnType<ReturnType<typeof createSupabaseBrowserClient>['channel']> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const supabase = createSupabaseBrowserClient();

    function refresh() {
      if (disposed || document.visibilityState === 'hidden' || pendingRef.current) return;
      startTransition(() => routerRef.current.refresh());
    }

    function refreshSoon() {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(refresh, EVENT_DEBOUNCE_MS);
    }

    function disconnect() {
      if (channel) void supabase.removeChannel(channel);
      channel = null;
    }

    function scheduleReconnect() {
      if (disposed || reconnectTimer) return;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
      attempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, delay);
    }

    function connect() {
      if (disposed) return;
      disconnect();
      channel = supabase
        .channel(`live-orders:${scope}:${branchId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'restaurant_orders', filter: `branch_id=eq.${branchId}` },
          refreshSoon,
        )
        .subscribe((status) => {
          if (disposed) return;
          if (status === 'SUBSCRIBED') {
            attempt = 0;
            // Anything that changed while the socket was down.
            refresh();
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            scheduleReconnect();
          }
        });
    }

    connect();
    const poll = setInterval(refresh, intervalMs);

    function onWake() {
      refresh();
      // A tab that slept may hold a dead socket the client has not noticed.
      if (!channel) scheduleReconnect();
    }
    function onVisibility() {
      if (document.visibilityState === 'visible') onWake();
    }
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onWake);

    return () => {
      disposed = true;
      clearInterval(poll);
      clearTimeout(debounceTimer);
      clearTimeout(reconnectTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onWake);
      disconnect();
    };
  }, [branchId, scope, intervalMs]);
}
