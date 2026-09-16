import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { Card, CardBody } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  getOrderDetail, FULFILLMENT_AR, ORDER_STATUS_AR, RECEIPT_DISCLAIMER_AR,
} from '@/modules/restaurant/account/service';
import { formatMoney } from '@/modules/restaurant/website/shared';
import { AccountShell, requireCustomer } from '../../shell';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'تفاصيل الطلب',
  robots: { index: false, follow: false },
};

/**
 * One order, as the customer who placed it may see it.
 *
 * The number in the URL is a filter, never an authorisation: the database
 * matches it only within this customer's own history, so a number belonging to
 * someone else — or to another restaurant — returns nothing and this page is
 * not found. There is no id to manipulate, because none is ever sent.
 *
 * What is shown is the customer's side of the order: what they ordered, what
 * it cost, where it is going. Staff notes, kitchen timings, invoice links and
 * internal ids are absent from the projection, not hidden by the template.
 */
export default async function OrderDetailPage({
  params,
}: {
  params: { orgSlug: string; number: string };
}) {
  const { site } = await requireCustomer(params.orgSlug);
  const order = await getOrderDetail({
    orgSlug: params.orgSlug,
    number: decodeURIComponent(params.number),
  });
  if (!order) notFound();

  const money = (cents: number) => formatMoney(cents, order.currency);

  return (
    <AccountShell
      site={site}
      orgSlug={params.orgSlug}
      active="/orders"
      title={`طلب #${order.number}`}
    >
      <Card>
        <CardBody className="space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={order.status === 'cancelled' ? 'danger' : 'info'}>
              {ORDER_STATUS_AR[order.status] ?? order.status}
            </Badge>
            <span className="text-sm text-muted">
              {FULFILLMENT_AR[order.type] ?? order.type} — {order.branchName}
            </span>
            <span className="ms-auto text-sm text-muted">
              {new Date(order.placedAt).toLocaleString('ar-EG', {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </span>
          </div>

          <table className="w-full text-sm">
            <caption className="sr-only">أصناف الطلب</caption>
            <thead>
              <tr className="border-b border-line text-muted">
                <th scope="col" className="p-2 text-start font-medium">الصنف</th>
                <th scope="col" className="p-2 text-center font-medium">الكمية</th>
                <th scope="col" className="p-2 text-end font-medium">الإجمالي</th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((item, index) => (
                <tr key={`${item.productName}-${index}`} className="border-b border-line/60">
                  <td className="p-2 text-fg">
                    {item.productName}
                    {item.variantName && item.variantName !== 'default' && (
                      <span className="text-muted"> — {item.variantName}</span>
                    )}
                  </td>
                  <td className="p-2 text-center text-muted">{item.quantity}</td>
                  <td className="p-2 text-end text-fg">{money(item.lineTotalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <dl className="space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted">الإجمالي قبل الإضافات</dt>
              <dd className="text-fg">{money(order.subtotalCents)}</dd>
            </div>
            {order.discountCents > 0 && (
              <div className="flex justify-between">
                <dt className="text-muted">الخصم</dt>
                <dd className="text-fg">− {money(order.discountCents)}</dd>
              </div>
            )}
            {order.taxCents > 0 && (
              <div className="flex justify-between">
                <dt className="text-muted">الضريبة</dt>
                <dd className="text-fg">{money(order.taxCents)}</dd>
              </div>
            )}
            {order.deliveryFeeCents > 0 && (
              <div className="flex justify-between">
                <dt className="text-muted">رسوم التوصيل</dt>
                <dd className="text-fg">{money(order.deliveryFeeCents)}</dd>
              </div>
            )}
            <div className="flex justify-between border-t border-line pt-2 text-base font-bold">
              <dt>الإجمالي</dt>
              <dd>{money(order.totalCents)}</dd>
            </div>
          </dl>

          {order.delivery && (
            <div className="rounded border border-line bg-surface p-3 text-sm">
              <p className="font-semibold text-fg">عنوان التوصيل</p>
              <p className="text-muted">
                {[order.delivery.city, order.delivery.area].filter(Boolean).join(' — ')}
              </p>
              <p className="text-muted">{order.delivery.address}</p>
              {order.delivery.landmark && (
                <p className="text-muted">علامة مميزة: {order.delivery.landmark}</p>
              )}
            </div>
          )}

          {/* Required wording. Local Basic issues receipts and claims no
              Egyptian e-invoice status. */}
          <p className="border-t border-line pt-3 text-xs leading-relaxed text-muted">
            {RECEIPT_DISCLAIMER_AR}
          </p>
        </CardBody>
      </Card>

      <Link href={`/r/${params.orgSlug}/account/orders`} className="text-sm text-muted hover:text-fg">
        العودة إلى الطلبات
      </Link>
    </AccountShell>
  );
}
