import Link from 'next/link';
import { Truck, Plus } from 'lucide-react';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import {
  listPurchaseOrders, PURCHASE_STATUS_LABELS, type PurchaseStatus,
} from '@/modules/retail/purchasing/service';
import { PageHeader } from '@/components/patterns/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Money } from '@/components/patterns/money';
import { EmptyState } from '@/components/patterns/states';

export const metadata = { title: 'المشتريات' };

const TONE: Record<PurchaseStatus, 'neutral' | 'info' | 'warn' | 'success' | 'danger'> = {
  draft: 'neutral',
  ordered: 'info',
  partially_received: 'warn',
  received: 'success',
  cancelled: 'danger',
};

export default async function PurchasesPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  const orders = await listPurchaseOrders(ctx);
  const base = `/${ctx.organizationSlug}/${ctx.branchSlug}`;
  const canManage = can(ctx, 'retail.purchase.manage');

  return (
    <div className="space-y-5">
      <PageHeader
        title="المشتريات"
        description={`${orders.length} أمر شراء في ${ctx.branchName}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href={`${base}/suppliers`}>
              <Button size="sm" variant="outline">الموردون</Button>
            </Link>
            {canManage ? (
              <Link href={`${base}/purchases/new`}>
                <Button size="sm">
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  أمر شراء جديد
                </Button>
              </Link>
            ) : null}
          </div>
        }
      />

      <Card>
        {orders.length === 0 ? (
          <EmptyState
            icon={Truck}
            title="لا توجد أوامر شراء بعد"
            description="سجّل أمر شراء لتتبّع ما طلبته من الموردين، واستلم البضاعة لتدخل المخزون."
            {...(canManage
              ? { action: { label: 'أمر شراء جديد', href: `${base}/purchases/new` } }
              : {})}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">أوامر الشراء</caption>
              <thead>
                <tr className="border-b border-line text-start text-xs text-muted">
                  <th scope="col" className="p-3 text-start font-medium">رقم الأمر</th>
                  <th scope="col" className="p-3 text-start font-medium">المورد</th>
                  <th scope="col" className="p-3 text-start font-medium">الإجمالي</th>
                  <th scope="col" className="p-3 text-start font-medium">المدفوع</th>
                  <th scope="col" className="p-3 text-start font-medium">الحالة</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} className="border-b border-line last:border-0 hover:bg-surface">
                    <td className="p-3">
                      <Link
                        href={`${base}/purchases/${o.id}`}
                        className="font-medium text-primary hover:underline"
                        dir="ltr"
                      >
                        {o.number}
                      </Link>
                    </td>
                    <td className="p-3 text-muted">{o.supplierName ?? '—'}</td>
                    <td className="p-3"><Money cents={o.totalCents} currency={ctx.currency} /></td>
                    <td className="p-3">
                      <Money
                        cents={o.paidCents}
                        currency={ctx.currency}
                        tone={o.paidCents >= o.totalCents && o.totalCents > 0 ? 'positive' : undefined}
                      />
                    </td>
                    <td className="p-3">
                      <Badge tone={TONE[o.status]}>{PURCHASE_STATUS_LABELS[o.status]}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
