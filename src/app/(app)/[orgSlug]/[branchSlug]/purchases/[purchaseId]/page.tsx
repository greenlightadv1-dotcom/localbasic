import Link from 'next/link';
import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import {
  getPurchaseOrder, PURCHASE_STATUS_LABELS, type PurchaseStatus,
} from '@/modules/retail/purchasing/service';
import { PageHeader } from '@/components/patterns/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Money } from '@/components/patterns/money';
import { CancelPurchase, PayPurchase, ReceivePurchase, SubmitPurchase } from './forms';

export const metadata = { title: 'أمر شراء' };

const TONE: Record<PurchaseStatus, 'neutral' | 'info' | 'warn' | 'success' | 'danger'> = {
  draft: 'neutral',
  ordered: 'info',
  partially_received: 'warn',
  received: 'success',
  cancelled: 'danger',
};

export default async function PurchaseDetailPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string; purchaseId: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  const order = await getPurchaseOrder(ctx, params.purchaseId);
  // Another tenant's order, or none: the same answer either way.
  if (!order) notFound();

  const base = `/${ctx.organizationSlug}/${ctx.branchSlug}`;
  const canManage = can(ctx, 'retail.purchase.manage');
  const canReceive = canManage && can(ctx, 'retail.inventory.adjust');
  const canPay = canManage && can(ctx, 'treasury.create');

  const open = order.status === 'ordered' || order.status === 'partially_received';
  const outstanding = order.lines.filter((l) => l.quantityReceived < l.quantityOrdered);
  const dueCents = Math.max(order.totalCents - order.paidCents, 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title={`أمر شراء ${order.number}`}
        description={order.supplierName ?? 'بدون مورد محدّد'}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={TONE[order.status]}>{PURCHASE_STATUS_LABELS[order.status]}</Badge>
            <Link href={`${base}/purchases`}>
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
              <caption className="sr-only">أصناف أمر الشراء</caption>
              <thead>
                <tr className="border-b border-line text-start text-xs text-muted">
                  <th scope="col" className="p-3 text-start font-medium">الصنف</th>
                  <th scope="col" className="p-3 text-start font-medium">المطلوب</th>
                  <th scope="col" className="p-3 text-start font-medium">المستلم</th>
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
                    <td className="p-3 lb-numeric">{l.quantityOrdered}</td>
                    <td className="p-3 lb-numeric">
                      <span
                        className={
                          l.quantityReceived >= l.quantityOrdered ? 'text-success' : 'text-warn'
                        }
                      >
                        {l.quantityReceived}
                      </span>
                    </td>
                    <td className="p-3">
                      <Money cents={l.unitCostCents} currency={order.currency} />
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
              <div className="flex items-center justify-between">
                <span className="text-muted">الإجمالي</span>
                <Money cents={order.totalCents} currency={order.currency} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted">المدفوع</span>
                <Money cents={order.paidCents} currency={order.currency} tone="positive" />
              </div>
              <div className="flex items-center justify-between border-t border-line pt-2 font-bold">
                <span>المتبقّي</span>
                <Money
                  cents={dueCents}
                  currency={order.currency}
                  tone={dueCents > 0 ? 'negative' : 'positive'}
                />
              </div>
              {order.notes ? (
                <p className="border-t border-line pt-2 text-muted">{order.notes}</p>
              ) : null}
            </CardBody>
          </Card>

          {order.status === 'draft' && canManage ? (
            <Card>
              <CardBody>
                <SubmitPurchase
                  orgSlug={params.orgSlug}
                  branchSlug={params.branchSlug}
                  id={order.id}
                />
              </CardBody>
            </Card>
          ) : null}

          {open && canPay && dueCents > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>دفع للمورد</CardTitle>
              </CardHeader>
              <CardBody>
                <PayPurchase
                  orgSlug={params.orgSlug}
                  branchSlug={params.branchSlug}
                  id={order.id}
                />
              </CardBody>
            </Card>
          ) : null}

          {order.status !== 'received' && order.status !== 'cancelled' && canManage ? (
            <Card>
              <CardBody>
                <CancelPurchase
                  orgSlug={params.orgSlug}
                  branchSlug={params.branchSlug}
                  id={order.id}
                />
              </CardBody>
            </Card>
          ) : null}
        </div>
      </div>

      {open && canReceive && outstanding.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>استلام البضاعة</CardTitle>
          </CardHeader>
          <CardBody>
            <p className="mb-3 text-sm text-muted">
              الكميات المُدخلة هنا تدخل المخزون فورًا، ولا يمكن استلام أكثر من المطلوب.
            </p>
            <ReceivePurchase
              orgSlug={params.orgSlug}
              branchSlug={params.branchSlug}
              id={order.id}
              lines={outstanding.map((l) => ({
                id: l.id,
                label:
                  l.variantName && l.variantName !== 'default'
                    ? `${l.productName} — ${l.variantName}`
                    : l.productName,
                outstanding: l.quantityOrdered - l.quantityReceived,
              }))}
            />
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
