import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import { AppError } from '@/lib/errors';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { getOrder } from '@/modules/restaurant/orders/service';
import { STATUS_LABELS, STATUS_TONES, type OrderStatus } from '@/modules/restaurant/orders/schemas';
import { PageHeader } from '@/components/patterns/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Money } from '@/components/patterns/money';

export const metadata = { title: 'تفاصيل الطلب' };
export const dynamic = 'force-dynamic';

export default async function OrderDetailPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string; orderId: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);

  let data;
  try {
    data = await getOrder(ctx, params.orderId);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }

  const { order, lines, tableName, invoice } = data;
  const base = `/${ctx.organizationSlug}/${ctx.branchSlug}`;
  const status = order.status as OrderStatus;

  const timeline = [
    { label: 'وصل الطلب', at: order.placed_at },
    { label: 'تم التأكيد', at: order.confirmed_at },
    { label: 'جاهز', at: order.ready_at },
    { label: 'تم التقديم', at: order.served_at },
    { label: 'اكتمل', at: order.completed_at },
    { label: 'أُلغي', at: order.cancelled_at },
  ].filter((step) => step.at);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Link href={`${base}/orders`}>
        <Button variant="ghost" size="sm">
          <ArrowRight className="h-4 w-4 lb-flip" aria-hidden="true" />
          الطلبات
        </Button>
      </Link>

      <PageHeader
        title={`طلب #${order.number}`}
        description={`${tableName ? `طاولة ${tableName}` : 'سفري'} · ${
          order.channel === 'qr' ? 'من رمز QR' : order.channel === 'waiter' ? 'من الكابتن' : 'من الكاشير'
        }`}
        actions={<Badge tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Badge>}
      />

      {order.cancel_reason && (
        <Card>
          <CardBody className="text-sm">
            <span className="font-semibold text-danger">سبب الإلغاء: </span>
            {order.cancel_reason}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>الأصناف</CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          <ul className="divide-y divide-line">
            {lines.map((line) => (
              <li key={line.id} className="flex items-start justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="font-medium">
                    <span className="lb-numeric me-2 text-primary">{line.quantity}×</span>
                    {line.productName}
                    {line.variantName !== 'default' && (
                      <span className="text-muted"> — {line.variantName}</span>
                    )}
                  </p>
                  {line.modifiers.length > 0 && (
                    <p className="mt-0.5 text-sm text-muted">
                      {line.modifiers.map((m) => m.name).join('، ')}
                    </p>
                  )}
                  {line.note && <p className="mt-0.5 text-sm text-warn">{line.note}</p>}
                </div>
                <Money cents={line.lineTotalCents} currency={order.currency} className="font-semibold" />
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      {can(ctx, 'invoice.read') && (
        <Card>
          <CardHeader>
            <CardTitle>الحساب</CardTitle>
          </CardHeader>
          <CardBody>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted">المجموع</dt>
                <dd>
                  <Money cents={order.subtotal_cents} currency={order.currency} />
                </dd>
              </div>
              {order.discount_cents > 0 && (
                <div className="flex justify-between text-success">
                  <dt>الخصم</dt>
                  <dd>
                    − <Money cents={order.discount_cents} currency={order.currency} />
                  </dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-muted">الضريبة</dt>
                <dd>
                  <Money cents={order.tax_cents} currency={order.currency} />
                </dd>
              </div>
              <div className="flex justify-between border-t border-line pt-2 text-base font-bold">
                <dt>الإجمالي</dt>
                <dd>
                  <Money cents={order.total_cents} currency={order.currency} />
                </dd>
              </div>
              {invoice && (
                <div className="flex justify-between pt-2">
                  <dt className="text-muted">رقم الإيصال</dt>
                  <dd className="lb-numeric font-semibold">{invoice.number}</dd>
                </div>
              )}
            </dl>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>المسار الزمني</CardTitle>
        </CardHeader>
        <CardBody>
          <ol className="space-y-2 text-sm">
            {timeline.map((step) => (
              <li key={step.label} className="flex justify-between">
                <span>{step.label}</span>
                <time className="lb-numeric text-muted" dateTime={String(step.at)}>
                  {new Date(String(step.at)).toLocaleString('ar-EG', {
                    hour: '2-digit',
                    minute: '2-digit',
                    day: '2-digit',
                    month: '2-digit',
                  })}
                </time>
              </li>
            ))}
          </ol>
        </CardBody>
      </Card>
    </div>
  );
}
