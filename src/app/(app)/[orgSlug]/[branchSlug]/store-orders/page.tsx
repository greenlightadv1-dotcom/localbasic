import Link from 'next/link';
import { ShoppingCart } from 'lucide-react';
import { resolveTenantContext } from '@/modules/core/tenancy/context';
import {
  listStoreOrders, ORDER_STATUS_LABELS, type OrderStatus,
} from '@/modules/retail/store/orders';
import { PageHeader } from '@/components/patterns/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Money } from '@/components/patterns/money';
import { EmptyState } from '@/components/patterns/states';

export const metadata = { title: 'طلبات المتجر' };

const TONE: Record<OrderStatus, 'neutral' | 'info' | 'warn' | 'success' | 'danger'> = {
  placed: 'warn',
  confirmed: 'info',
  packed: 'info',
  fulfilled: 'info',
  completed: 'success',
  cancelled: 'danger',
};

export default async function StoreOrdersPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  const orders = await listStoreOrders(ctx);
  const base = `/${ctx.organizationSlug}/${ctx.branchSlug}`;

  return (
    <div className="space-y-5">
      <PageHeader
        title="طلبات المتجر"
        description={`${orders.length} طلب في ${ctx.branchName}`}
      />

      <Card>
        {orders.length === 0 ? (
          <EmptyState
            icon={ShoppingCart}
            title="لا توجد طلبات بعد"
            description="الطلبات القادمة من المتجر الإلكتروني ستظهر هنا."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">طلبات المتجر</caption>
              <thead>
                <tr className="border-b border-line text-start text-xs text-muted">
                  <th scope="col" className="p-3 text-start font-medium">رقم الطلب</th>
                  <th scope="col" className="p-3 text-start font-medium">العميل</th>
                  <th scope="col" className="p-3 text-start font-medium">الاستلام</th>
                  <th scope="col" className="p-3 text-start font-medium">الإجمالي</th>
                  <th scope="col" className="p-3 text-start font-medium">الحالة</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} className="border-b border-line last:border-0 hover:bg-surface">
                    <td className="p-3">
                      <Link
                        href={`${base}/store-orders/${o.id}`}
                        className="font-medium text-primary hover:underline"
                        dir="ltr"
                      >
                        {o.number}
                      </Link>
                    </td>
                    <td className="p-3">
                      <span className="text-fg">{o.contactName}</span>
                      <span className="block text-xs text-muted" dir="ltr">{o.contactPhone}</span>
                    </td>
                    <td className="p-3 text-muted">
                      {o.fulfillment === 'delivery' ? 'توصيل' : 'استلام من الفرع'}
                    </td>
                    <td className="p-3"><Money cents={o.totalCents} currency={ctx.currency} /></td>
                    <td className="p-3">
                      <Badge tone={TONE[o.status]}>{ORDER_STATUS_LABELS[o.status]}</Badge>
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
