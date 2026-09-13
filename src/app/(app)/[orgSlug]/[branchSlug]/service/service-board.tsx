'use client';

import { useEffect, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { BellRing, ConciergeBell } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/field';
import { Money } from '@/components/patterns/money';
import { EmptyState } from '@/components/patterns/states';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import type { OrderSummary } from '@/modules/restaurant/orders/service';
import type { FloorTable } from '@/modules/restaurant/tables/service';
import { TABLE_STATUSES, type TableStatus } from '@/modules/restaurant/tables/schemas';
import { STATUS_LABELS, STATUS_TONES } from '@/modules/restaurant/orders/schemas';
import { setOrderStatusAction, setTableStatusAction } from '../restaurant-actions';

const TABLE_LABELS: Record<TableStatus, string> = {
  available: 'متاحة',
  reserved: 'محجوزة',
  occupied: 'مشغولة',
  waiting_payment: 'بانتظار الدفع',
  cleaning: 'تنظيف',
};

const TABLE_TONES: Record<TableStatus, 'neutral' | 'info' | 'warn' | 'success' | 'danger'> = {
  available: 'success',
  reserved: 'info',
  occupied: 'warn',
  waiting_payment: 'danger',
  cleaning: 'neutral',
};

/**
 * The waiter's view: what is ready to run, and the state of the floor.
 *
 * No totals to collect and no payment button — the waiter role holds no
 * financial permission, so those actions would be refused server-side anyway.
 * Open amounts are shown because the floor needs to know a table has a bill
 * running, not because the waiter can settle it.
 */
export function ServiceBoard({
  orders,
  floor,
  currency,
  canSetTableStatus,
  organizationSlug,
  branchSlug,
}: {
  orders: OrderSummary[];
  floor: FloorTable[];
  currency: string;
  canSetTableStatus: boolean;
  organizationSlug: string;
  branchSlug: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    const refresh = setInterval(() => router.refresh(), 20_000);
    return () => clearInterval(refresh);
  }, [router]);

  const ready = orders.filter((o) => o.status === 'ready');
  const inFlight = orders.filter((o) => ['new', 'confirmed', 'preparing'].includes(o.status));

  function markServed(orderId: string) {
    startTransition(async () => {
      const result = await setOrderStatusAction(
        { organizationSlug, branchSlug },
        { orderId, status: 'served' },
      );
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success('تم تسجيل التقديم');
      router.refresh();
    });
  }

  function changeTable(tableId: string, status: TableStatus) {
    startTransition(async () => {
      const result = await setTableStatusAction({ organizationSlug, branchSlug }, { tableId, status });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[420px_1fr]">
      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>جاهز للتقديم</CardTitle>
          <Badge tone={ready.length ? 'success' : 'neutral'}>{ready.length}</Badge>
        </CardHeader>
        <CardBody className="p-0">
          {ready.length === 0 ? (
            <EmptyState
              icon={BellRing}
              title="لا يوجد طلبات جاهزة"
              description="سيظهر الطلب هنا فور تجهيزه في المطبخ."
            />
          ) : (
            <ul className="divide-y divide-line">
              {ready.map((order) => (
                <li key={order.id} className="flex items-center justify-between gap-3 p-4">
                  <div>
                    <p className="text-lg font-bold">
                      {order.tableName ? <>طاولة <bdi>{order.tableName}</bdi></> : 'سفري'}
                    </p>
                    <p className="lb-numeric text-sm text-muted">
                      #{order.number} · {order.itemCount} أصناف
                    </p>
                  </div>
                  <Button size="touch" disabled={isPending} onClick={() => markServed(order.id)}>
                    تم التقديم
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>الطاولات</CardTitle>
          </CardHeader>
          <CardBody>
            {floor.length === 0 ? (
              <EmptyState icon={ConciergeBell} title="لا توجد طاولات" />
            ) : (
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                {floor.map((table) => (
                  <li
                    key={table.id}
                    className={cn(
                      'space-y-2 rounded border p-3',
                      table.status === 'available' ? 'border-line' : 'border-primary/30 bg-primary-soft/40',
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-lg font-bold">{table.name}</span>
                      <Badge tone={TABLE_TONES[table.status]}>{TABLE_LABELS[table.status]}</Badge>
                    </div>
                    <p className="text-xs text-muted">
                      {table.sectionName ?? '—'} · {table.seats} مقاعد
                    </p>
                    {table.openOrderCount > 0 && (
                      <p className="text-sm font-semibold">
                        <Money cents={table.openTotalCents} currency={currency} />
                        <span className="ms-1 text-xs font-normal text-muted">
                          ({table.openOrderCount} طلب)
                        </span>
                      </p>
                    )}
                    {canSetTableStatus && (
                      <>
                        <label htmlFor={`table-${table.id}`} className="sr-only">
                          حالة الطاولة {table.name}
                        </label>
                        <Select
                          id={`table-${table.id}`}
                          value={table.status}
                          disabled={isPending}
                          onChange={(e) => changeTable(table.id, e.target.value as TableStatus)}
                          className="h-9 text-xs"
                        >
                          {TABLE_STATUSES.map((status) => (
                            <option key={status} value={status}>
                              {TABLE_LABELS[status]}
                            </option>
                          ))}
                        </Select>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>قيد التحضير</CardTitle>
          </CardHeader>
          <CardBody className="p-0">
            {inFlight.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted">لا يوجد طلبات قيد التحضير.</p>
            ) : (
              <ul className="divide-y divide-line">
                {inFlight.map((order) => (
                  <li key={order.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                    <span className="font-medium">
                      {order.tableName ? <>طاولة <bdi>{order.tableName}</bdi></> : 'سفري'}
                      <span className="lb-numeric ms-2 text-muted">#{order.number}</span>
                    </span>
                    <Badge tone={STATUS_TONES[order.status]}>{STATUS_LABELS[order.status]}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
