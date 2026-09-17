'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { advanceOrderAction, cancelOrderAction, completeOrderAction } from '../actions';

type Scope = { orgSlug: string; branchSlug: string; id: string };

export function AdvanceOrder({
  orgSlug, branchSlug, id, status, label,
}: Scope & { status: 'confirmed' | 'packed' | 'fulfilled'; label: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button
        type="button"
        className="w-full"
        disabled={isPending}
        data-testid="advance-order"
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await advanceOrderAction(
              { organizationSlug: orgSlug, branchSlug },
              { id, status },
            );
            if (!result.ok) { setError(result.error); return; }
            router.refresh();
          })
        }
      >
        {isPending ? '…' : label}
      </Button>
    </div>
  );
}

/**
 * Completion: the step that issues a receipt and takes the money.
 *
 * The method is chosen here and validated again in the database; the amount is
 * never chosen — it is the order total, computed server-side.
 */
export function CompleteOrder({ orgSlug, branchSlug, id }: Scope) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState<'cash' | 'card' | 'transfer' | 'wallet' | 'other'>('cash');

  return (
    <div className="space-y-2 border-t border-line pt-3">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Field label="طريقة الدفع">
        {(p) => (
          <Select
            {...p}
            value={method}
            data-testid="complete-method"
            onChange={(e) => setMethod(e.target.value as typeof method)}
          >
            <option value="cash">نقدًا</option>
            <option value="card">بطاقة</option>
            <option value="transfer">تحويل</option>
            <option value="wallet">محفظة</option>
            <option value="other">أخرى</option>
          </Select>
        )}
      </Field>

      <Button
        type="button"
        className="w-full"
        disabled={isPending}
        data-testid="complete-order"
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await completeOrderAction(
              { organizationSlug: orgSlug, branchSlug },
              { id, method },
            );
            if (!result.ok) { setError(result.error); return; }
            router.refresh();
          })
        }
      >
        {isPending ? '…' : 'إصدار الإيصال وإنهاء الطلب'}
      </Button>
    </div>
  );
}

export function CancelOrder({ orgSlug, branchSlug, id }: Scope) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="space-y-2 border-t border-line pt-3">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {confirming ? (
        <>
          <p className="text-sm text-muted">الإلغاء يعيد الأصناف إلى المخزون.</p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isPending}
              data-testid="cancel-order-confirm"
              onClick={() =>
                startTransition(async () => {
                  setError(null);
                  const result = await cancelOrderAction(
                    { organizationSlug: orgSlug, branchSlug },
                    { id, reason: '' },
                  );
                  if (!result.ok) { setError(result.error); return; }
                  router.refresh();
                })
              }
            >
              {isPending ? '…' : 'تأكيد الإلغاء'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              تراجع
            </Button>
          </div>
        </>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-testid="cancel-order"
          onClick={() => setConfirming(true)}
        >
          إلغاء الطلب
        </Button>
      )}
    </div>
  );
}
