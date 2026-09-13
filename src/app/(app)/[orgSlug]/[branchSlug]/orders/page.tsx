import Link from 'next/link';
import { ClipboardList } from 'lucide-react';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { listOrders } from '@/modules/restaurant/orders/service';
import { STATUS_LABELS, STATUS_TONES, type OrderStatus } from '@/modules/restaurant/orders/schemas';
import { PageHeader } from '@/components/patterns/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Money } from '@/components/patterns/money';
import { EmptyState } from '@/components/patterns/states';

export const metadata = { title: 'الطلبات' };
export const dynamic = 'force-dynamic';

const FILTERS: { key: string; label: string; statuses?: OrderStatus[] }[] = [
  { key: 'open', label: 'المفتوحة', statuses: ['new', 'confirmed', 'preparing', 'ready', 'served'] },
  { key: 'completed', label: 'المكتملة', statuses: ['completed'] },
  { key: 'cancelled', label: 'الملغاة', statuses: ['cancelled'] },
  { key: 'all', label: 'الكل' },
];

export default async function OrdersPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; branchSlug: string };
  searchParams: { filter?: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  const active = FILTERS.find((f) => f.key === searchParams.filter) ?? FILTERS[0]!;
  const orders = await listOrders(ctx, {
    ...(active.statuses ? { statuses: active.statuses } : {}),
    limit: 200,
  });
  const base = `/${ctx.organizationSlug}/${ctx.branchSlug}`;

  return (
    <div className="space-y-5">
      <PageHeader title="الطلبات" description={`${orders.length} طلب — ${ctx.branchName}`} />

      <nav aria-label="تصفية الطلبات" className="flex flex-wrap gap-2">
        {FILTERS.map((filter) => (
          <Link
            key={filter.key}
            href={`${base}/orders?filter=${filter.key}`}
            aria-current={filter.key === active.key ? 'page' : undefined}
            className={
              filter.key === active.key
                ? 'rounded bg-primary px-3 py-1.5 text-sm font-semibold text-primary-fg'
                : 'rounded border border-line bg-elevated px-3 py-1.5 text-sm text-muted hover:bg-surface'
            }
          >
            {filter.label}
          </Link>
        ))}
      </nav>

      <Card>
        {orders.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title="لا توجد طلبات"
            description="ستظهر الطلبات هنا فور استلامها من الكاشير أو من رمز QR."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">قائمة الطلبات</caption>
              <thead>
                <tr className="border-b border-line text-xs text-muted">
                  <th scope="col" className="p-3 text-start font-medium">رقم</th>
                  <th scope="col" className="p-3 text-start font-medium">الطاولة</th>
                  <th scope="col" className="p-3 text-start font-medium">المصدر</th>
                  <th scope="col" className="p-3 text-start font-medium">الأصناف</th>
                  <th scope="col" className="p-3 text-start font-medium">الإجمالي</th>
                  <th scope="col" className="p-3 text-start font-medium">الحالة</th>
                  <th scope="col" className="p-3 text-start font-medium">الوقت</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id} className="border-b border-line last:border-0 hover:bg-surface">
                    <td className="p-3">
                      <Link
                        href={`${base}/orders/${order.id}`}
                        className="lb-numeric font-semibold text-primary hover:underline"
                      >
                        #{order.number}
                      </Link>
                    </td>
                    <td className="p-3">{order.tableName ? <>طاولة <bdi>{order.tableName}</bdi></> : 'سفري'}</td>
                    <td className="p-3">
                      {order.channel === 'qr' ? (
                        <Badge tone="info">QR</Badge>
                      ) : order.channel === 'waiter' ? (
                        <Badge>كابتن</Badge>
                      ) : (
                        <Badge>كاشير</Badge>
                      )}
                    </td>
                    <td className="p-3 lb-numeric">{order.itemCount}</td>
                    <td className="p-3">
                      <Money cents={order.totalCents} currency={ctx.currency} />
                      {order.paidCents > 0 && order.paidCents < order.totalCents && (
                        <span className="ms-1 text-xs text-warn">جزئي</span>
                      )}
                    </td>
                    <td className="p-3">
                      <Badge tone={STATUS_TONES[order.status]}>{STATUS_LABELS[order.status]}</Badge>
                    </td>
                    <td className="p-3 lb-numeric text-muted">
                      {new Date(order.placedAt).toLocaleTimeString('ar-EG', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {!can(ctx, 'payment.read') && (
        <p className="text-xs text-muted">بعض التفاصيل المالية مخفية حسب صلاحياتك.</p>
      )}
    </div>
  );
}
