import Link from 'next/link';
import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import {
  getStoreOrder, NEXT_STATUS, ORDER_STATUS_LABELS, type OrderStatus,
} from '@/modules/retail/store/orders';
import { PageHeader } from '@/components/patterns/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Money } from '@/components/patterns/money';
import { AdvanceOrder, CancelOrder, CompleteOrder } from './forms';
import { OrderShipping } from './shipping';

export const metadata = { title: 'طلب متجر' };

const TONE: Record<OrderStatus, 'neutral' | 'info' | 'warn' | 'success' | 'danger'> = {
  placed: 'warn',
  confirmed: 'info',
  packed: 'info',
  fulfilled: 'info',
  completed: 'success',
  cancelled: 'danger',
};

const NEXT_LABEL: Record<string, string> = {
  confirmed: 'تأكيد الطلب',
  packed: 'تم التجهيز',
  fulfilled: 'تم التسليم',
};

export default async function StoreOrderPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string; orderId: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  const order = await getStoreOrder(ctx, params.orderId);
  // Another tenant's order, or none: the same answer.
  if (!order) notFound();

  const base = `/${ctx.organizationSlug}/${ctx.branchSlug}`;
  const canManage = can(ctx, 'retail.order.manage');
  const canComplete =
    canManage && can(ctx, 'invoice.create') && can(ctx, 'payment.create');
  const next = NEXT_STATUS[order.status];
  const open = order.status !== 'completed' && order.status !== 'cancelled';

  return (
    <div className="space-y-5">
      <PageHeader
        title={`طلب ${order.number}`}
        description={`${order.contactName} · ${order.fulfillment === 'delivery' ? 'توصيل' : 'استلام من الفرع'}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={TONE[order.status]}>{ORDER_STATUS_LABELS[order.status]}</Badge>
            <Link href={`${base}/store-orders`}>
              <Button size="sm" variant="ghost">رجوع</Button>
            </Link>
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>الأصناف</CardTitle>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">أصناف الطلب</caption>
              <thead>
                <tr className="border-b border-line text-start text-xs text-muted">
                  <th scope="col" className="p-3 text-start font-medium">الصنف</th>
                  <th scope="col" className="p-3 text-start font-medium">الكمية</th>
                  <th scope="col" className="p-3 text-start font-medium">سعر الوحدة</th>
                  <th scope="col" className="p-3 text-start font-medium">الإجمالي</th>
                </tr>
              </thead>
              <tbody>
                {order.lines.map((l) => (
                  <tr key={l.id} className="border-b border-line last:border-0">
                    <td className="p-3">
                      <span className="font-medium text-fg">{l.productName}</span>
                      {l.variantName && l.variantName !== 'default' ? (
                        <span className="text-muted"> — {l.variantName}</span>
                      ) : null}
                    </td>
                    <td className="p-3 lb-numeric">{l.quantity}</td>
                    <td className="p-3">
                      <Money cents={l.unitPriceCents} currency={order.currency} />
                    </td>
                    <td className="p-3">
                      <Money cents={l.lineTotalCents} currency={order.currency} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>الحساب</CardTitle>
            </CardHeader>
            <CardBody className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted">المجموع</span>
                <Money cents={order.subtotalCents} currency={order.currency} />
              </div>
              {order.taxCents > 0 ? (
                <div className="flex justify-between">
                  <span className="text-muted">الضريبة</span>
                  <Money cents={order.taxCents} currency={order.currency} />
                </div>
              ) : null}
              {order.deliveryFeeCents > 0 ? (
                <div className="flex justify-between">
                  <span className="text-muted">رسوم التوصيل</span>
                  <Money cents={order.deliveryFeeCents} currency={order.currency} />
                </div>
              ) : null}
              <div className="flex justify-between border-t border-line pt-2 font-bold">
                <span>الإجمالي</span>
                <Money cents={order.totalCents} currency={order.currency} />
              </div>
              {order.invoiceId ? (
                <Link
                  href={`${base}/invoices/${order.invoiceId}`}
                  className="block pt-2 text-primary hover:underline"
                >
                  عرض الإيصال
                </Link>
              ) : null}
              {order.cancelReason ? (
                <p className="border-t border-line pt-2 text-danger">{order.cancelReason}</p>
              ) : null}
            </CardBody>
          </Card>

          {order.delivery ? (
            <Card>
              <CardHeader>
                <CardTitle>عنوان التوصيل</CardTitle>
              </CardHeader>
              <CardBody className="space-y-1 text-sm">
                <p className="font-medium text-fg">{order.delivery.recipientName}</p>
                <p className="text-muted" dir="ltr">{order.delivery.phone}</p>
                <p className="text-muted">
                  {order.delivery.city}
                  {order.delivery.area ? ` — ${order.delivery.area}` : ''}
                </p>
                <p className="text-muted">{order.delivery.addressLine}</p>
                {order.delivery.landmark ? (
                  <p className="text-muted">{order.delivery.landmark}</p>
                ) : null}
              </CardBody>
            </Card>
          ) : null}

          {/* Only a delivery order has anything to ship. */}
          {order.fulfillment === 'delivery' ? (
            <OrderShipping
              ctx={ctx}
              orderId={order.id}
              orgSlug={params.orgSlug}
              branchSlug={params.branchSlug}
            />
          ) : null}

          {order.note ? (
            <Card>
              <CardHeader>
                <CardTitle>ملاحظات العميل</CardTitle>
              </CardHeader>
              <CardBody className="text-sm text-muted">{order.note}</CardBody>
            </Card>
          ) : null}

          {open && canManage ? (
            <Card>
              <CardBody className="space-y-3">
                {next ? (
                  <AdvanceOrder
                    orgSlug={params.orgSlug}
                    branchSlug={params.branchSlug}
                    id={order.id}
                    status={next}
                    label={NEXT_LABEL[next] ?? next}
                  />
                ) : null}

                {order.status === 'fulfilled' && canComplete ? (
                  <CompleteOrder
                    orgSlug={params.orgSlug}
                    branchSlug={params.branchSlug}
                    id={order.id}
                  />
                ) : null}

                <CancelOrder
                  orgSlug={params.orgSlug}
                  branchSlug={params.branchSlug}
                  id={order.id}
                />
              </CardBody>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
