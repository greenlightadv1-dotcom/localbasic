import Link from 'next/link';
import type { Metadata } from 'next';
import { Card, CardBody } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { getOrders, FULFILLMENT_AR, ORDER_STATUS_AR } from '@/modules/restaurant/account/service';
import { formatMoney } from '@/modules/restaurant/website/shared';
import { AccountShell, requireCustomer } from '../shell';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'طلباتي',
  robots: { index: false, follow: false },
};

/**
 * The customer's own order history at THIS restaurant.
 *
 * The list is not filtered here. It arrives already scoped: the database keys
 * it to the customer row, which belongs to exactly one organization, so
 * "mine" and "this restaurant's" are the same condition and there is no
 * parameter a customer could vary to widen it.
 */
export default async function OrdersPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { claimed?: string };
}) {
  const { site } = await requireCustomer(params.orgSlug);
  const orders = await getOrders(params.orgSlug);

  return (
    <AccountShell site={site} orgSlug={params.orgSlug} active="/orders" title="طلباتي">
      {searchParams.claimed && <Alert tone="success">تم ربط طلبك بحسابك.</Alert>}

      {orders.length === 0 ? (
        <Card>
          <CardBody className="space-y-2 p-8 text-center">
            <p className="font-semibold text-fg">لا توجد طلبات بعد</p>
            <p className="text-sm text-muted">أول طلب تقوم به من هنا سيظهر في هذه الصفحة.</p>
            <Link
              href={`/r/${params.orgSlug}`}
              className="inline-flex h-11 items-center rounded bg-primary px-4 text-sm font-semibold text-primary-fg"
            >
              تصفّح المنيو
            </Link>
          </CardBody>
        </Card>
      ) : (
        <ul className="space-y-3">
          {orders.map((order) => (
            <li key={order.number}>
              <Link
                href={`/r/${params.orgSlug}/account/orders/${encodeURIComponent(order.number)}`}
                className="block rounded border border-line bg-elevated p-4 transition-colors hover:border-primary"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold text-fg" dir="ltr">
                    #{order.number}
                  </span>
                  <Badge tone={order.status === 'cancelled' ? 'danger' : 'info'}>
                    {ORDER_STATUS_AR[order.status] ?? order.status}
                  </Badge>
                  <span className="ms-auto font-bold text-fg">
                    {formatMoney(order.totalCents, order.currency)}
                  </span>
                </div>
                <p className="mt-1 text-sm text-muted">
                  {order.branchName} — {FULFILLMENT_AR[order.type] ?? order.type} —{' '}
                  {order.itemCount} صنف
                </p>
                <p className="text-xs text-muted">
                  {new Date(order.placedAt).toLocaleString('ar-EG', {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </AccountShell>
  );
}
