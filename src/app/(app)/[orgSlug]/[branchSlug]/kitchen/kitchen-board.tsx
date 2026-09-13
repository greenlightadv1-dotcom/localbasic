'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ChefHat, Clock, StickyNote } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/patterns/states';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import type { OrderLine, OrderSummary } from '@/modules/restaurant/orders/service';
import { setOrderStatusAction } from '../restaurant-actions';

type Ticket = { summary: OrderSummary; lines: OrderLine[] };

/** Minutes since the order was placed, for the ageing colour. */
function minutesSince(iso: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}

const COLUMNS = [
  { status: 'confirmed' as const, title: 'جديد', next: 'preparing' as const, action: 'ابدأ التحضير' },
  { status: 'preparing' as const, title: 'تحت التحضير', next: 'ready' as const, action: 'جاهز' },
  { status: 'ready' as const, title: 'جاهز للتقديم', next: null, action: null },
];

/**
 * The kitchen display.
 *
 * Built for a tablet at arm's length in a hot, busy room: three columns, large
 * type, one button per ticket, high contrast, and no financial information of
 * any kind — the kitchen role cannot read it and does not need it.
 */
export function KitchenBoard({
  tickets,
  organizationSlug,
  branchSlug,
}: {
  tickets: Ticket[];
  organizationSlug: string;
  branchSlug: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [isPending, startTransition] = useTransition();
  const [now, setNow] = useState(() => Date.now());

  // Ticket ages tick without a request; the board itself refreshes on a slower
  // beat so a new order appears without anyone touching the screen.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    const refresh = setInterval(() => router.refresh(), 20_000);
    return () => {
      clearInterval(tick);
      clearInterval(refresh);
    };
  }, [router]);

  function advance(orderId: string, status: 'preparing' | 'ready') {
    startTransition(async () => {
      const result = await setOrderStatusAction(
        { organizationSlug, branchSlug },
        { orderId, status },
      );
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(status === 'ready' ? 'الطلب جاهز للتقديم' : 'بدأ التحضير');
      router.refresh();
    });
  }

  if (tickets.length === 0) {
    return (
      <EmptyState
        icon={ChefHat}
        title="لا توجد طلبات في المطبخ"
        description="ستظهر الطلبات هنا فور تأكيدها من الكاشير أو الكابتن."
      />
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {COLUMNS.map((column) => {
        const columnTickets = tickets.filter((t) => t.summary.status === column.status);
        return (
          <section key={column.status} aria-label={column.title} className="space-y-3">
            <h2 className="flex items-center justify-between text-base font-bold">
              {column.title}
              <Badge tone={column.status === 'ready' ? 'success' : 'info'}>
                {columnTickets.length}
              </Badge>
            </h2>

            {columnTickets.length === 0 ? (
              <p className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-muted">
                لا شيء هنا
              </p>
            ) : (
              <ul className="space-y-3">
                {columnTickets.map(({ summary, lines }) => {
                  const age = minutesSince(summary.placedAt);
                  const late = age >= 15;
                  const warn = age >= 8 && !late;
                  return (
                    <li
                      key={summary.id}
                      className={cn(
                        'rounded-lg border-2 bg-elevated p-4 shadow-card',
                        late ? 'border-danger' : warn ? 'border-warn' : 'border-line',
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-xl font-bold">
                            {summary.tableName ? `طاولة ${summary.tableName}` : 'سفري'}
                          </p>
                          <p className="lb-numeric text-sm text-muted">#{summary.number}</p>
                        </div>
                        <span
                          className={cn(
                            'flex items-center gap-1 rounded px-2 py-1 text-sm font-bold lb-numeric',
                            late
                              ? 'bg-danger/10 text-danger'
                              : warn
                                ? 'bg-warn/10 text-warn'
                                : 'bg-surface text-muted',
                          )}
                        >
                          <Clock className="h-4 w-4" aria-hidden="true" />
                          {age}د
                        </span>
                      </div>

                      <ul className="mt-3 space-y-2 border-t border-line pt-3">
                        {lines.map((line) => (
                          <li key={line.id} className="text-base">
                            <p className="font-semibold">
                              <span className="lb-numeric me-2 text-primary">{line.quantity}×</span>
                              {line.productName}
                              {line.variantName !== 'default' && (
                                <span className="text-muted"> — {line.variantName}</span>
                              )}
                            </p>
                            {line.modifiers.length > 0 && (
                              <p className="ps-6 text-sm text-muted">
                                {line.modifiers.map((m) => m.name).join('، ')}
                              </p>
                            )}
                            {line.note && (
                              <p className="ps-6 text-sm font-medium text-warn">
                                <StickyNote className="inline h-3.5 w-3.5" aria-hidden="true" />{' '}
                                {line.note}
                              </p>
                            )}
                          </li>
                        ))}
                      </ul>

                      {summary.note && (
                        <p className="mt-3 rounded bg-warn/10 p-2 text-sm font-medium text-warn">
                          ملاحظة الطلب: {summary.note}
                        </p>
                      )}

                      {column.next && (
                        <Button
                          size="touch"
                          block
                          className="mt-3"
                          disabled={isPending}
                          onClick={() => advance(summary.id, column.next!)}
                        >
                          {column.action}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
      <p className="sr-only" aria-live="polite">
        {tickets.length} طلب في المطبخ، آخر تحديث {new Date(now).toLocaleTimeString('ar-EG')}
      </p>
    </div>
  );
}
