'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import {
  cancelPurchaseAction, payPurchaseAction, receivePurchaseAction, submitPurchaseAction,
} from '../actions';

type Scope = { orgSlug: string; branchSlug: string; id: string };

export function SubmitPurchase({ orgSlug, branchSlug, id }: Scope) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <p className="text-sm text-muted">
        إرسال الأمر للمورد. بعدها يمكن تسجيل الاستلام.
      </p>
      <Button
        type="button"
        size="sm"
        disabled={isPending}
        data-testid="submit-purchase"
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await submitPurchaseAction(
              { organizationSlug: orgSlug, branchSlug },
              { id },
            );
            if (!result.ok) { setError(result.error); return; }
            router.refresh();
          })
        }
      >
        {isPending ? '…' : 'إرسال للمورد'}
      </Button>
    </div>
  );
}

export function ReceivePurchase({
  orgSlug, branchSlug, id, lines,
}: Scope & { lines: { id: string; label: string; outstanding: number }[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [quantities, setQuantities] = useState<Record<string, string>>(
    Object.fromEntries(lines.map((l) => [l.id, String(l.outstanding)])),
  );

  function onSubmit() {
    setError(null);
    const entries = lines
      .map((l) => ({ itemId: l.id, quantity: Number(quantities[l.id] ?? 0) }))
      .filter((l) => l.quantity > 0);

    if (entries.length === 0) {
      setError('أدخل كمية واحدة على الأقل.');
      return;
    }

    startTransition(async () => {
      const result = await receivePurchaseAction(
        { organizationSlug: orgSlug, branchSlug },
        { purchaseOrderId: id, lines: entries, note: '' },
      );
      if (!result.ok) { setError(result.error); return; }
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {lines.map((l) => (
          <Field key={l.id} label={`${l.label} — متبقٍّ ${l.outstanding}`}>
            {(p) => (
              <Input
                {...p}
                dir="ltr"
                inputMode="decimal"
                data-testid={`receive-${l.id}`}
                value={quantities[l.id] ?? ''}
                onChange={(e) =>
                  setQuantities((q) => ({ ...q, [l.id]: e.target.value }))
                }
              />
            )}
          </Field>
        ))}
      </div>

      <Button type="button" disabled={isPending} data-testid="receive-purchase" onClick={onSubmit}>
        {isPending ? '…' : 'تسجيل الاستلام'}
      </Button>
    </div>
  );
}

export function PayPurchase({ orgSlug, branchSlug, id }: Scope) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState('');

  return (
    <div className="space-y-3">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Field label="المبلغ">
        {(p) => (
          <Input
            {...p}
            dir="ltr"
            inputMode="decimal"
            placeholder="0.00"
            data-testid="pay-amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        )}
      </Field>

      <Button
        type="button"
        size="sm"
        disabled={isPending}
        data-testid="pay-purchase"
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await payPurchaseAction(
              { organizationSlug: orgSlug, branchSlug },
              { purchaseOrderId: id, amountCents: amount || '0', note: '' },
            );
            if (!result.ok) { setError(result.error); return; }
            setAmount('');
            router.refresh();
          })
        }
      >
        {isPending ? '…' : 'تسجيل الدفع'}
      </Button>
    </div>
  );
}

export function CancelPurchase({ orgSlug, branchSlug, id }: Scope) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="space-y-2">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {confirming ? (
        <>
          <p className="text-sm text-muted">
            الإلغاء يغلق الأمر ولا يسحب ما تم استلامه من المخزون.
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isPending}
              data-testid="cancel-purchase-confirm"
              onClick={() =>
                startTransition(async () => {
                  setError(null);
                  const result = await cancelPurchaseAction(
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
          data-testid="cancel-purchase"
          onClick={() => setConfirming(true)}
        >
          إلغاء الأمر
        </Button>
      )}
    </div>
  );
}
