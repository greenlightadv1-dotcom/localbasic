'use client';

import { Fragment, useEffect, useState } from 'react';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { STATUS_LABELS } from './status-labels';

/**
 * Live order status, animated.
 *
 * Four customer-facing stages, folding the six-value database enum down to
 * what a customer actually needs to see:
 *   new/confirmed → preparing → ready/served → completed
 * `cancelled` is not a stage on this path — it replaces the whole stepper,
 * the same way the database treats it as reachable from any non-terminal
 * state rather than a step in the sequence.
 *
 * REALTIME. Subscribes to the SAME capability-token channel
 * app.broadcast_order_status() (0067) sends to — the topic name is the
 * token, so only someone holding this page's own URL can derive it. The
 * broadcast payload carries only `status`; nothing here trusts it for money
 * or order contents, which came from the page's own server-rendered load.
 * `private: false` on the channel matches that: no Realtime Authorization
 * policy is needed because the topic itself is the credential, exactly like
 * the token already is for the page's initial, server-side fetch.
 */

const STAGES = [
  { key: 'received', label: 'تم استلام الطلب', statuses: ['new', 'confirmed'] },
  { key: 'preparing', label: 'المطبخ يجهز طلبك', statuses: ['preparing'] },
  { key: 'ready', label: 'جاهز', statuses: ['ready', 'served'] },
  { key: 'completed', label: 'مكتمل', statuses: ['completed'] },
] as const;

function stageIndex(status: string): number {
  const i = STAGES.findIndex((s) => (s.statuses as readonly string[]).includes(status));
  return i === -1 ? 0 : i;
}

export function OrderProgress({ token, initialStatus }: { token: string; initialStatus: string }) {
  const [status, setStatus] = useState(initialStatus);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    const channel = supabase
      .channel(`order-status:${token}`, { config: { broadcast: { self: false } } })
      .on('broadcast', { event: 'status' }, ({ payload }) => {
        const next = (payload as { status?: string } | null)?.status;
        if (next) setStatus(next);
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [token]);

  if (status === 'cancelled') {
    return (
      <div className="rounded-lg border border-danger/40 bg-danger/10 p-4 text-center" role="status">
        <p className="font-semibold text-danger">تم إلغاء الطلب</p>
      </div>
    );
  }

  const current = stageIndex(status);

  return (
    <div role="status" aria-live="polite">
      <p className="mb-4 font-semibold text-primary">{STATUS_LABELS[status] ?? status}</p>
      <div className="flex items-center">
        {STAGES.map((stage, i) => (
          <Fragment key={stage.key}>
            <span
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold transition-all duration-500 ${
                i < current
                  ? 'bg-primary text-primary-fg'
                  : i === current
                    ? 'lavechi-ring-pulse bg-primary text-primary-fg'
                    : 'bg-surface text-muted ring-1 ring-line'
              }`}
              aria-hidden="true"
            >
              {i < current ? '✓' : i + 1}
            </span>
            {i < STAGES.length - 1 && (
              <span
                className={`h-0.5 flex-1 transition-colors duration-700 ${
                  i < current ? 'bg-primary' : 'bg-line'
                }`}
                aria-hidden="true"
              />
            )}
          </Fragment>
        ))}
      </div>
      <div className="mt-2 flex">
        {STAGES.map((stage, i) => (
          <span
            key={stage.key}
            className={`flex-1 text-center text-[11px] leading-tight sm:text-xs ${
              i === current ? 'font-semibold text-fg' : 'text-muted'
            }`}
          >
            {stage.label}
          </span>
        ))}
      </div>
    </div>
  );
}
