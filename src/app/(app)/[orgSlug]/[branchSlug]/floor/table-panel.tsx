'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeftRight, Combine, Receipt, Scissors, Sparkles, Unlink, X } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { formatMoney } from '@/lib/money';
import type { FloorPlanTable } from '@/modules/restaurant/floor/service';
import { setTableStatusAction } from '../restaurant-actions';
import { unmergeTableAction } from './actions';
import { SplitDialog } from './split-dialog';
import { STATUS_LABEL, STATUS_TONE, minutesSince, type FloorCan } from './floor-view';

type Scope = { organizationSlug: string; branchSlug: string };

const ORDER_STATUS: Record<string, string> = {
  new: 'جديد', confirmed: 'في المطبخ', preparing: 'تحت التحضير', ready: 'جاهز', served: 'تم التقديم',
};

export function TablePanel({
  scope, basePath, currency, table, tables, can, onClose, onTransfer, onMerge,
}: {
  scope: Scope; basePath: string; currency: string; table: FloorPlanTable; tables: FloorPlanTable[];
  can: FloorCan; onClose: () => void; onTransfer: (orderId?: string) => void; onMerge: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [splitting, setSplitting] = useState<string | null>(null);
  const primary = table.mergedInto ? tables.find((t) => t.id === table.mergedInto) ?? null : null;
  const partners = tables.filter((t) => t.mergedInto === table.id);
  const holder = primary ?? table;
  const orders = holder.orders;
  const total = orders.reduce((s, o) => s + o.totalCents, 0);

  function setStatus(status: 'available' | 'reserved' | 'waiting_payment' | 'occupied', ok: string) {
    start(async () => {
      const r = await setTableStatusAction(scope, { tableId: holder.id, status });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success(ok);
      router.refresh();
    });
  }

  function unmerge() {
    start(async () => {
      const r = await unmergeTableAction(scope, { tableId: table.id });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success('تم فك الدمج');
      router.refresh();
    });
  }

  return (
    <Card data-testid="table-panel">
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <CardTitle className="flex flex-wrap items-center gap-2">
          طاولة <bdi>{table.name}</bdi>
          <span className={cn('rounded border-2 px-2 py-0.5 text-xs font-semibold', STATUS_TONE[holder.status])}>
            {STATUS_LABEL[holder.status] ?? holder.status}
          </span>
        </CardTitle>
        <button type="button" onClick={onClose} className="rounded p-1 text-muted hover:text-fg" aria-label="إغلاق">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </CardHeader>
      <CardBody className="space-y-4 text-sm">
        <p className="text-muted">
          {table.seats} مقاعد
          {primary && <> · مدموجة مع <bdi className="font-semibold text-fg">{primary.name}</bdi> (فاتورة واحدة)</>}
          {partners.length > 0 && <> · معها: {partners.map((p) => p.name).join('، ')}</>}
          {table.heldFor && <> · محجوزة لـ <span className="font-semibold text-fg">{table.heldFor}</span></>}
        </p>

        {orders.length === 0 ? (
          <p className="rounded border border-dashed border-line p-3 text-center text-muted">لا توجد طلبات مفتوحة.</p>
        ) : (
          <ul className="space-y-2" data-testid="table-orders">
            {orders.map((o) => (
              <li key={o.id} className="rounded border border-line p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold lb-numeric">#{o.number}</span>
                  <Badge tone={o.status === 'ready' ? 'success' : o.status === 'served' ? 'neutral' : 'info'}>{ORDER_STATUS[o.status] ?? o.status}</Badge>
                </div>
                <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted">
                  <span className="lb-numeric">{minutesSince(o.placedAt)} دقيقة</span>
                  <span className="lb-numeric font-semibold text-fg">{formatMoney(o.totalCents, currency)}</span>
                </div>
                {can.operate && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Button size="sm" variant="outline" disabled={pending || Boolean(o.invoiceId)} onClick={() => setSplitting(o.id)}
                      title={o.invoiceId ? 'بدأ تحصيل هذا الطلب' : undefined} data-testid="split-check">
                      <Scissors className="h-3.5 w-3.5" aria-hidden="true" /> تقسيم
                    </Button>
                    {orders.length > 1 && (
                      <Button size="sm" variant="ghost" disabled={pending} onClick={() => onTransfer(o.id)}>
                        <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden="true" /> نقل هذا الطلب فقط
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
            {orders.length > 1 && (
              <li className="flex justify-between px-1 text-sm font-semibold">
                <span>الإجمالي</span><span className="lb-numeric">{formatMoney(total, currency)}</span>
              </li>
            )}
          </ul>
        )}

        <div className="flex flex-wrap gap-2">
          {can.operate && orders.length > 0 && !primary && (
            <Button size="sm" onClick={() => onTransfer()} disabled={pending} data-testid="transfer-table">
              <ArrowLeftRight className="h-4 w-4" aria-hidden="true" /> نقل الطاولة
            </Button>
          )}
          {can.operate && !primary && (
            <Button size="sm" variant="outline" onClick={onMerge} disabled={pending} data-testid="merge-tables">
              <Combine className="h-4 w-4" aria-hidden="true" /> دمج مع طاولات
            </Button>
          )}
          {can.operate && primary && (
            <Button size="sm" variant="outline" onClick={unmerge} disabled={pending}>
              <Unlink className="h-4 w-4" aria-hidden="true" /> فك الدمج
            </Button>
          )}
          {can.setStatus && holder.status === 'occupied' && orders.length > 0 && (
            <Button size="sm" variant="outline" className="border-amber-500 text-amber-800" onClick={() => setStatus('waiting_payment', 'الطاولة تنتظر الحساب')} disabled={pending}>
              <Receipt className="h-4 w-4" aria-hidden="true" /> طلب الحساب
            </Button>
          )}
          {can.setStatus && holder.status === 'cleaning' && (
            <Button size="sm" variant="outline" className="border-emerald-500 text-emerald-800" onClick={() => setStatus('available', 'الطاولة جاهزة')} disabled={pending}>
              <Sparkles className="h-4 w-4" aria-hidden="true" /> تم التنظيف
            </Button>
          )}
          {can.setStatus && holder.status === 'available' && (
            <Button size="sm" variant="ghost" onClick={() => setStatus('reserved', 'تم حجز الطاولة')} disabled={pending}>حجز</Button>
          )}
          {can.setStatus && holder.status === 'reserved' && !table.heldFor && (
            <Button size="sm" variant="ghost" onClick={() => setStatus('available', 'أُلغي الحجز')} disabled={pending}>إلغاء الحجز</Button>
          )}
          {can.cashier && orders.length > 0 && (
            <Link href={`${basePath}/cashier`} className="inline-flex h-9 items-center rounded px-3 text-sm font-semibold text-primary hover:bg-primary-soft">
              التحصيل في الكاشير
            </Link>
          )}
        </div>
      </CardBody>
      {splitting && (
        <SplitDialog scope={scope} currency={currency} orderId={splitting}
          orderNumber={orders.find((o) => o.id === splitting)?.number ?? ''}
          onClose={() => setSplitting(null)} />
      )}
    </Card>
  );
}
