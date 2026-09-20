import Link from 'next/link';
import { Suspense } from 'react';
import {
  Receipt,
  TrendingUp,
  Wallet,
  ClipboardList,
  ChefHat,
  BellRing,
  LayoutGrid,
  ArrowLeft,
} from 'lucide-react';
import { resolveTenantContext, can, type TenantContext } from '@/modules/core/tenancy/context';
import { getRestaurantReport, resolveRange } from '@/modules/restaurant/reports/service';
import { listOrders } from '@/modules/restaurant/orders/service';
import { listFloor } from '@/modules/restaurant/tables/service';
import { STATUS_LABELS, STATUS_TONES, type OrderStatus } from '@/modules/restaurant/orders/schemas';
import { PageHeader } from '@/components/patterns/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Money } from '@/components/patterns/money';
import { Skeleton, EmptyState } from '@/components/patterns/states';

export const metadata = { title: 'لوحة التحكم' };
export const dynamic = 'force-dynamic';

function Stat({
  label,
  value,
  icon: Icon,
  href,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  icon: React.ComponentType<{ className?: string }>;
  href?: string;
  tone?: 'positive' | 'negative';
}) {
  const body = (
    <CardBody className="flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <p className="text-xs font-medium text-muted">{label}</p>
        <p
          className={
            tone === 'positive'
              ? 'truncate text-xl font-bold text-success'
              : tone === 'negative'
                ? 'truncate text-xl font-bold text-danger'
                : 'truncate text-xl font-bold'
          }
        >
          {value}
        </p>
      </div>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-primary-soft">
        <Icon className="h-4 w-4 text-primary" />
      </span>
    </CardBody>
  );

  return href ? (
    <Card className="transition-colors hover:border-primary/40">
      <Link href={href}>{body}</Link>
    </Card>
  ) : (
    <Card>{body}</Card>
  );
}

async function RestaurantSummary({ ctx }: { ctx: TenantContext }) {
  const base = `/${ctx.organizationSlug}/${ctx.branchSlug}`;
  const [report, orders, floor] = await Promise.all([
    getRestaurantReport(ctx, resolveRange('today', undefined, undefined, ctx.timezone)),
    listOrders(ctx, { statuses: ['new', 'confirmed', 'preparing', 'ready', 'served'] }),
    can(ctx, 'restaurant.table.read') ? listFloor(ctx) : Promise.resolve([]),
  ]);

  const byStatus = (status: OrderStatus) => orders.filter((o) => o.status === status).length;
  const busyTables = floor.filter((t) => t.status !== 'available' && t.status !== 'cleaning').length;

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {can(ctx, 'payment.read') && (
          <Stat
            label="مبيعات اليوم"
            icon={TrendingUp}
            href={`${base}/reports`}
            value={<Money cents={report.revenueCents} currency={ctx.currency} />}
          />
        )}
        <Stat
          label="طلبات مفتوحة"
          icon={ClipboardList}
          href={`${base}/orders`}
          value={orders.length.toLocaleString('ar-EG')}
        />
        {can(ctx, 'restaurant.table.read') && (
          <Stat
            label="طاولات مشغولة"
            icon={LayoutGrid}
            href={`${base}/tables`}
            value={`${busyTables.toLocaleString('ar-EG')} / ${floor.length.toLocaleString('ar-EG')}`}
          />
        )}
        {can(ctx, 'treasury.read') && (
          <Stat
            label="صافي الحركة اليوم"
            icon={Wallet}
            href={`${base}/treasury`}
            tone={report.netCents >= 0 ? 'positive' : 'negative'}
            value={<Money cents={report.netCents} currency={ctx.currency} />}
          />
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="flex items-center justify-between">
            <CardTitle>حالة الخدمة الآن</CardTitle>
            <Link
              href={`${base}/orders`}
              className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              كل الطلبات
              <ArrowLeft className="h-3 w-3" aria-hidden="true" />
            </Link>
          </CardHeader>
          <CardBody className="space-y-2">
            {(['new', 'confirmed', 'preparing', 'ready', 'served'] as OrderStatus[]).map(
              (status) => {
                const count = byStatus(status);
                return (
                  <div key={status} className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2">
                      <Badge tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Badge>
                    </span>
                    <span className="lb-numeric font-semibold">{count}</span>
                  </div>
                );
              },
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader className="flex items-center justify-between">
            <CardTitle>جاهز للتقديم</CardTitle>
            <Badge tone={byStatus('ready') ? 'success' : 'neutral'}>{byStatus('ready')}</Badge>
          </CardHeader>
          <CardBody className="p-0">
            {byStatus('ready') === 0 ? (
              <EmptyState icon={BellRing} title="لا يوجد طلب جاهز" />
            ) : (
              <ul className="divide-y divide-line">
                {orders
                  .filter((o) => o.status === 'ready')
                  .slice(0, 6)
                  .map((order) => (
                    <li key={order.id} className="flex items-center justify-between p-3 text-sm">
                      <span className="font-medium">
                        {order.tableName ? `طاولة ${order.tableName}` : 'سفري'}
                      </span>
                      <span className="lb-numeric text-muted">#{order.number}</span>
                    </li>
                  ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>الأكثر طلبًا اليوم</CardTitle>
          </CardHeader>
          <CardBody className="p-0">
            {report.topProducts.length === 0 ? (
              <EmptyState icon={ChefHat} title="لا توجد مبيعات بعد اليوم" />
            ) : (
              <ul className="divide-y divide-line">
                {report.topProducts.slice(0, 6).map((product) => (
                  <li
                    key={product.name}
                    className="flex items-center justify-between gap-2 p-3 text-sm"
                  >
                    <span className="min-w-0 truncate">{product.name}</span>
                    <span className="lb-numeric shrink-0 font-semibold text-muted">
                      {product.quantity}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function SummarySkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[88px]" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-64" />
        ))}
      </div>
    </div>
  );
}

export default async function DashboardPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  const isRestaurant = ctx.enabledModules.includes('restaurant');
  const base = `/${ctx.organizationSlug}/${ctx.branchSlug}`;

  const shortcuts = [
    { href: `${base}/cashier`, label: 'الكاشير', permission: 'restaurant.pos.use' as const },
    { href: `${base}/kitchen`, label: 'المطبخ', permission: 'restaurant.kitchen.use' as const },
    { href: `${base}/tables`, label: 'الطاولات و QR', permission: 'restaurant.table.read' as const },
    { href: `${base}/menu`, label: 'المنيو', permission: 'restaurant.menu.read' as const },
  ].filter((s) => can(ctx, s.permission));

  return (
    <div className="space-y-5">
      <PageHeader
        title={ctx.organizationName}
        description={`${ctx.branchName} — ${new Date().toLocaleDateString('ar-EG', {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
        })}`}
        actions={
          shortcuts.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {shortcuts.map((shortcut) => (
                <Link
                  key={shortcut.href}
                  href={shortcut.href}
                  className="rounded border border-line bg-elevated px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:border-primary hover:text-primary"
                >
                  {shortcut.label}
                </Link>
              ))}
            </div>
          )
        }
      />

      {isRestaurant && can(ctx, 'restaurant.order.read') ? (
        <Suspense fallback={<SummarySkeleton />}>
          <RestaurantSummary ctx={ctx} />
        </Suspense>
      ) : (
        <Card>
          <EmptyState
            icon={Receipt}
            title="لا توجد بيانات لعرضها"
            description="صلاحياتك الحالية لا تتيح عرض ملخص لوحة التحكم. تواصل مع مدير النظام."
          />
        </Card>
      )}
    </div>
  );
}
