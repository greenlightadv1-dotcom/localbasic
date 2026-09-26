'use client';

import { useEffect, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { cancelOrderAction, type TrackState } from '../../actions';

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="h-11 rounded border border-danger/40 bg-danger/10 px-5 text-sm font-semibold text-danger hover:bg-danger/20 disabled:opacity-50"
    >
      {pending ? '…' : label}
    </button>
  );
}

/**
 * The 60-second countdown.
 *
 * Display only. It starts from the number the server sent and is allowed to be
 * wrong; the server re-checks its own deadline on every edit and cancel, so a
 * tampered clock buys nothing.
 */
// The window the server actually grants — see restaurant_orders.customer_edit_until
// in 0036/0040. Only used here to size the progress bar; the deadline itself is
// always the server's, never this constant.
const GRACE_WINDOW_SECONDS = 60;

export function EditWindow({
  token,
  canEdit,
  secondsLeft,
}: {
  token: string;
  canEdit: boolean;
  secondsLeft: number;
}) {
  const [left, setLeft] = useState(secondsLeft);
  const [state, action] = useFormState<TrackState, FormData>(cancelOrderAction, undefined);

  useEffect(() => {
    if (left <= 0) return;
    const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [left]);

  if (!canEdit || left <= 0) {
    return (
      <p className="rounded border border-line bg-surface px-4 py-3 text-sm text-muted">
        انتهت مهلة التعديل. للتغيير تواصل مع المطعم مباشرة.
      </p>
    );
  }

  const percentLeft = Math.round((left / GRACE_WINDOW_SECONDS) * 100);

  return (
    <div className="rounded border border-warn/40 bg-warn/10 p-4">
      <p className="mb-2 text-sm font-semibold text-fg">
        يمكنك إلغاء الطلب أو تعديله خلال{' '}
        <span data-testid="seconds-left" className="font-mono">{left}</span> ثانية
      </p>
      <div
        role="progressbar"
        aria-label="الوقت المتبقي لإلغاء الطلب"
        aria-valuemin={0}
        aria-valuemax={GRACE_WINDOW_SECONDS}
        aria-valuenow={left}
        className="mb-3 h-2 w-full overflow-hidden rounded-full bg-warn/20"
      >
        <div
          className="h-full rounded-full bg-warn transition-[width] duration-1000 ease-linear"
          style={{ width: `${percentLeft}%` }}
        />
      </div>
      {state?.error ? <p className="mb-2 text-sm text-danger">{state.error}</p> : null}
      {state?.ok ? <p className="mb-2 text-sm text-success">{state.ok}</p> : null}
      <form action={action} className="flex gap-2">
        <input type="hidden" name="token" value={token} />
        <input
          name="reason"
          placeholder="السبب (اختياري)"
          maxLength={240}
          className="h-11 flex-1 rounded border border-line bg-elevated px-3 text-sm text-fg"
        />
        <Submit label="إلغاء الطلب" />
      </form>
    </div>
  );
}
