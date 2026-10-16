'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, MapPin, Navigation, Phone, Send } from 'lucide-react';
import { Card, CardBody } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';
import { useLiveOrders } from '@/lib/realtime/use-live-orders';
import { formatMoney } from '@/lib/money';
import type { DispatchOrder, Driver } from '@/modules/restaurant/delivery/service';
import { myShiftAction, setDeliveryStatusAction } from '../delivery/actions';
import { JOB_LABEL } from '../delivery/dispatch-view';

type Scope = { organizationSlug: string; branchSlug: string };

/**
 * Big buttons, one trip per card. A driver can move only their own trips;
 * returns go through the dispatcher (they cancel food and may need a PIN).
 */
export function MyDeliveries({ scope, branchId, currency, driver, orders }: {
  scope: Scope; branchId: string; currency: string; driver: Driver; orders: DispatchOrder[];
}) {
  useLiveOrders(branchId, 'my-deliveries', 10_000);
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const money = (c: number) => formatMoney(c, currency);
  const active = orders.filter((o) => o.job && ['assigned', 'dispatched', 'in_transit'].includes(o.job.status));
  const delivered = orders.filter((o) => o.job?.status === 'delivered' && !o.job.settledAt);

  function move(o: DispatchOrder, status: 'dispatched' | 'in_transit' | 'delivered') {
    setBusyId(o.orderId);
    start(async () => {
      const r = await setDeliveryStatusAction(scope, { orderId: o.orderId, status });
      setBusyId(null);
      if (!r.ok) { toast.error(r.error); return; }
      toast.success({ dispatched: 'بالتوفيق!', in_transit: 'في الطريق', delivered: 'تم التسليم' }[status]);
      router.refresh();
    });
  }

  function shift() {
    start(async () => {
      const r = await myShiftAction(scope, { driverId: driver.id, on: !driver.onShift });
      if (!r.ok) { toast.error(r.error); return; }
      router.refresh();
    });
  }

  return (
    <div className="mx-auto max-w-lg space-y-3">
      <Card>
        <CardBody className="flex items-center justify-between gap-2">
          <div className="text-sm">
            <p>العهدة: <strong className="lb-numeric">{money(driver.custodyCents)}</strong></p>
            <p>العمولة المستحقة: <strong className="lb-numeric">{money(driver.commissionCents)}</strong></p>
          </div>
          <Button size="touch" variant={driver.onShift ? 'secondary' : 'primary'} disabled={pending} onClick={shift}>
            {driver.onShift ? 'إنهاء الوردية' : 'بدء الوردية'}
          </Button>
        </CardBody>
      </Card>

      {active.length === 0 && <p className="py-8 text-center text-sm text-muted">لا توجد رحلات معيّنة لك الآن.</p>}
      {active.map((o) => {
        const due = Math.max(o.totalCents - o.paidCents, 0);
        const s = o.job!.status;
        const mapQ = o.address ? encodeURIComponent([o.address.address, o.address.area, o.address.city].filter(Boolean).join(', ')) : '';
        return (
          <Card key={o.orderId} data-testid={`trip-${o.number}`}>
            <CardBody className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-lg font-bold">#{o.number}</p>
                <Badge tone="info">{JOB_LABEL[s]}</Badge>
              </div>
              <p className="font-medium">{o.address?.recipient ?? o.guestName}</p>
              {o.address && (
                <a href={`https://maps.google.com/?q=${mapQ}`} target="_blank" rel="noreferrer" className="flex items-start gap-1 text-sm text-primary">
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {[o.address.area, o.address.address, o.address.landmark].filter(Boolean).join(' — ')}
                </a>
              )}
              {(o.address?.phone || o.guestPhone) && (
                <a href={`tel:${o.address?.phone ?? o.guestPhone}`} className="flex items-center gap-1 text-sm text-primary" dir="ltr">
                  <Phone className="h-4 w-4" aria-hidden="true" /> {o.address?.phone ?? o.guestPhone}
                </a>
              )}
              {o.address?.notes && <p className="text-xs text-muted">{o.address.notes}</p>}
              <p className="rounded bg-surface p-2 text-center">
                {due > 0 ? <>حصّل من العميل <strong className="lb-numeric text-lg">{money(due)}</strong></> : <strong className="text-success">مدفوع — لا تحصيل</strong>}
              </p>
              {s === 'assigned' && (
                <Button size="touch" block disabled={pending || o.orderStatus !== 'ready'} onClick={() => move(o, 'dispatched')}>
                  <Send className="h-5 w-5" aria-hidden="true" /> {o.orderStatus === 'ready' ? 'استلمت الطلب — خروج' : 'بانتظار المطبخ…'}
                </Button>
              )}
              {s === 'dispatched' && (
                <Button size="touch" variant="secondary" block disabled={pending} onClick={() => move(o, 'in_transit')}>
                  <Navigation className="h-5 w-5" aria-hidden="true" /> في الطريق
                </Button>
              )}
              {(s === 'dispatched' || s === 'in_transit') && (
                <Button size="touch" block disabled={pending && busyId === o.orderId} onClick={() => move(o, 'delivered')} data-testid="trip-delivered">
                  <CheckCircle2 className="h-5 w-5" aria-hidden="true" /> تم التسليم
                </Button>
              )}
            </CardBody>
          </Card>
        );
      })}

      {delivered.length > 0 && (
        <Card>
          <CardBody>
            <p className="mb-1 text-sm font-medium">سُلّمت — بانتظار التوريد</p>
            <ul className="divide-y divide-line text-sm">
              {delivered.map((o) => (
                <li key={o.orderId} className="flex justify-between py-1"><span>#{o.number}</span><span className="lb-numeric">{money(o.job!.cashToCollectCents)}</span></li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
