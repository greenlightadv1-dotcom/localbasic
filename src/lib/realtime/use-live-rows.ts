'use client';

import { useEffect, useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

export type LiveSource = { table: string; filter: string };

const EVENT_DEBOUNCE_MS = 250;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Refreshes a server-rendered screen when rows it shows change: a companion
 * to useLiveOrders for tables other than restaurant_orders — order lines
 * (0117), so one station's bump reaches the other screens at once, and the
 * tables themselves (0105), so a status set from another device shows.
 *
 * Same contract as useLiveOrders: a router.refresh() in a transition (client
 * state such as an open modal or a half-built order survives), debounced,
 * one in flight at a time, rebuilt with backoff when the socket drops. It
 * has no poll of its own: pair it with useLiveOrders, whose poll is the
 * backstop. `onEvent` lets a screen react before the refresh lands (a chime).
 */
export function useLiveRows(key: string, sources: LiveSource[], onEvent?: (table: string, event: string) => void) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const pendingRef = useRef(false);
  pendingRef.current = isPending;
  const routerRef = useRef(router);
  routerRef.current = router;
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const signature = sources.map((s) => `${s.table}?${s.filter}`).join('|');

  useEffect(() => {
    if (!signature) return;
    let disposed = false;
    let attempt = 0;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    const supabase = createSupabaseBrowserClient();
    let channel: ReturnType<typeof supabase.channel> | null = null;

    function refreshSoon() {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (disposed || document.visibilityState === 'hidden' || pendingRef.current) return;
        startTransition(() => routerRef.current.refresh());
      }, EVENT_DEBOUNCE_MS);
    }

    function connect() {
      if (disposed) return;
      if (channel) void supabase.removeChannel(channel);
      let c = supabase.channel(`live-rows:${key}`);
      for (const part of signature.split('|')) {
        const [table, filter] = part.split('?') as [string, string];
        c = c.on('postgres_changes', { event: '*', schema: 'public', table, filter }, (payload) => {
          onEventRef.current?.(table, payload.eventType);
          refreshSoon();
        });
      }
      channel = c.subscribe((status) => {
        if (disposed) return;
        if (status === 'SUBSCRIBED') attempt = 0;
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          if (reconnect) return;
          const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
          attempt += 1;
          reconnect = setTimeout(() => { reconnect = undefined; connect(); }, delay);
        }
      });
    }

    connect();
    return () => {
      disposed = true;
      clearTimeout(debounce);
      clearTimeout(reconnect);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [key, signature]);
}
