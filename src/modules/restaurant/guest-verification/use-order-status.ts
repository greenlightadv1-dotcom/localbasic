'use client';

import { useEffect } from 'react';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

/**
 * Subscribes to the same capability-token broadcast channel
 * app.broadcast_order_status() (0067) already sends every order's status
 * change to — the one /order/track/[token]'s own progress stepper uses. The
 * topic name is the token, so only someone holding it can derive the
 * channel; no Realtime Authorization policy is needed for the same reason
 * the token itself already guards the page's server-side fetch.
 *
 * Used here for one thing: noticing the moment a 'pending_verification'
 * order the gateway webhook just advanced becomes 'new', so the checkout
 * flow can move on without the customer doing anything.
 */
export function useOrderStatusBroadcast(token: string | null, onStatus: (status: string) => void) {
  useEffect(() => {
    if (!token) return;
    const supabase = createSupabaseBrowserClient();
    const channel = supabase
      .channel(`order-status:${token}`, { config: { broadcast: { self: false } } })
      .on('broadcast', { event: 'status' }, ({ payload }) => {
        const next = (payload as { status?: string } | null)?.status;
        if (next) onStatus(next);
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
}
