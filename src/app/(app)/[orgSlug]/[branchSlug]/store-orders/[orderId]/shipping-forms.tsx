'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import {
  createShipmentAction, payShipmentAction, setShipmentStatusAction,
} from '../actions';
import type { ShipmentStatus } from '@/modules/retail/shipping/service';

type Scope = { orgSlug: string; branchSlug: string };

export function CreateShipment({
  orgSlug, branchSlug, orderId, providers, retry,
}: Scope & {
  orderId: string;
  providers: { id: string; name: string; defaultCostCents: number }[];
  retry: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '');
  const [cost, setCost] = useState(
    providers[0] ? (providers[0].defaultCostCents / 100).toFixed(2) : '0.00',
  );
  const [tracking, setTracking] = useState('');

  return (
    <div className="space-y-3">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <h3 className="text-sm font-bold text-fg">
        {retry ? 'محاولة شحن جديدة' : 'إرسال شحنة'}
      </h3>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="شركة الشحن">
          {(p) => (
            <Select
              {...p}
              value={providerId}
              data-testid="shipment-provider"
              onChange={(e) => {
                setProviderId(e.target.value);
                const chosen = providers.find((x) => x.id === e.target.value);
                if (chosen) setCost((chosen.defaultCostCents / 100).toFixed(2));
              }}
            >
              <option value="">بدون شركة</option>
              {providers.map((p2) => (
                <option key={p2.id} value={p2.id}>{p2.name}</option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="تكلفة الشحن على المتجر">
          {(p) => (
            <Input
              {...p}
              dir="ltr"
              inputMode="decimal"
              data-testid="shipment-cost"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
          )}
        </Field>

        <Field label="رقم التتبّع (إن وُجد)">
          {(p) => (
            <Input
              {...p}
              dir="ltr"
              data-testid="shipment-tracking"
              value={tracking}
              onChange={(e) => setTracking(e.target.value)}
            />
          )}
        </Field>
      </div>

      <Button
        type="button"
        size="sm"
        disabled={isPending}
        data-testid="create-shipment"
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await createShipmentAction(
              { organizationSlug: orgSlug, branchSlug },
              { orderId, providerId: providerId || null, costCents: cost, trackingCode: tracking },
            );
            if (!result.ok) { setError(result.error); return; }
            setTracking('');
            router.refresh();
          })
        }
      >
        {isPending ? '…' : 'إنشاء الشحنة'}
      </Button>
    </div>
  );
}

export function ShipmentStatusButtons({
  orgSlug, branchSlug, id, status,
}: Scope & { id: string; status: ShipmentStatus }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [failing, setFailing] = useState(false);
  const [reason, setReason] = useState('');

  function move(next: 'dispatched' | 'delivered' | 'failed' | 'cancelled', why?: string) {
    startTransition(async () => {
      setError(null);
      const result = await setShipmentStatusAction(
        { organizationSlug: orgSlug, branchSlug },
        { id, status: next, reason: why ?? '' },
      );
      if (!result.ok) { setError(result.error); return; }
      setFailing(false);
      setReason('');
      router.refresh();
    });
  }

  if (status === 'delivered' || status === 'failed' || status === 'cancelled') return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {error ? <Alert tone="danger" className="w-full">{error}</Alert> : null}

      {status === 'pending' ? (
        <>
          <Button
            type="button" size="sm" disabled={isPending}
            data-testid="dispatch-shipment"
            onClick={() => move('dispatched')}
          >
            تم الإرسال
          </Button>
          <Button
            type="button" size="sm" variant="ghost" disabled={isPending}
            data-testid="cancel-shipment"
            onClick={() => move('cancelled')}
          >
            إلغاء الشحنة
          </Button>
        </>
      ) : (
        <Button
          type="button" size="sm" disabled={isPending}
          data-testid="deliver-shipment"
          onClick={() => move('delivered')}
        >
          تم التسليم
        </Button>
      )}

      {failing ? (
        <span className="flex items-center gap-2">
          <Input
            dir="rtl"
            placeholder="سبب التعذّر"
            aria-label="سبب التعذّر"
            data-testid="failure-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button
            type="button" size="sm" variant="outline" disabled={isPending || !reason.trim()}
            data-testid="confirm-failure"
            onClick={() => move('failed', reason)}
          >
            تأكيد
          </Button>
        </span>
      ) : (
        <Button
          type="button" size="sm" variant="ghost"
          data-testid="fail-shipment"
          onClick={() => setFailing(true)}
        >
          تعذّر التسليم
        </Button>
      )}
    </div>
  );
}

export function PayShipment({ orgSlug, branchSlug, id }: Scope & { id: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      {error ? <Alert tone="danger" className="w-full">{error}</Alert> : null}
      <Button
        type="button" size="sm" variant="outline" disabled={isPending}
        data-testid="pay-shipment"
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await payShipmentAction(
              { organizationSlug: orgSlug, branchSlug },
              { id },
            );
            if (!result.ok) { setError(result.error); return; }
            router.refresh();
          })
        }
      >
        {isPending ? '…' : 'تسوية تكلفة الشحن'}
      </Button>
    </>
  );
}
