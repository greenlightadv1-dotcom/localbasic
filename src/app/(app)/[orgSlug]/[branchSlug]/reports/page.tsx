import Link from 'next/link';
import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import {
  getRestaurantReport,
  resolveRange,
  type DateRangeKey,
} from '@/modules/restaurant/reports/service';
import { PageHeader } from '@/components/patterns/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Money } from '@/components/patterns/money';
import { EmptyState } from '@/components/patterns/states';
import { BarChart3 } from 'lucide-react';

export const metadata = { title: 'التقارير' };
export const dynamic = 'force-dynamic';

const RANGES: { key: DateRangeKey; label: string }[] = [
  { key: 'today', label: 'اليوم' },
  { key: 'yesterday', label: 'أمس' },
  { key: 'week', label: 'آخر ٧ أيام' },
  { key: 'month', label: 'هذا الشهر' },
];

const METHOD_LABELS: Record<string, string> = {
  cash: 'نقدي',
  card: 'بطاقة',
  transfer: 'تحويل',
  wallet: 'محفظة',
  online: 'أونلاين',
  other: 'أخرى',
};

function Stat({
  label,
  children,
  tone,
}: {
  label: string;
  children: React.ReactNode;
  tone?: 'positive' | 'negative';
}) {
  return (
    <Card>
      <CardBody className="space-y-1">
        <p className="text-xs font-medium text-muted">{label}</p>
        <p
          className={
            tone === 'positive'
              ? 'text-xl font-bold text-success'
              : tone === 'negative'
                ? 'text-xl font-bold text-danger'
                : 'text-xl font-bold'
          }
        >
          {children}
        </p>
      </CardBody>
    </Card>
  );
}

export default async function ReportsPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; branchSlug: string };
  searchParams: { range?: string; from?: string; to?: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'report.read')) notFound();

  const rangeKey = (RANGES.find((r) => r.key === searchParams.range)?.key ??
    (searchParams.from ? 'custom' : 'today')) as DateRangeKey;
  const range = resolveRange(rangeKey, searchParams.from, searchParams.to);
  const report = await getRestaurantReport(ctx, range);
  const base = `/${ctx.organizationSlug}/${ctx.branchSlug}`;

  return (
    <div className="space-y-5">
      <PageHeader title="التقارير" description={`${ctx.branchName} — تقارير المبيعات والحركة`} />

      <nav aria-label="الفترة الزمنية" className="flex flex-wrap gap-2">
        {RANGES.map((r) => (
          <Link
            key={r.key}
            href={`${base}/reports?range=${r.key}`}
            aria-current={r.key === rangeKey ? 'page' : undefined}
            className={
              r.key === rangeKey
                ? 'rounded bg-primary px-3 py-1.5 text-sm font-semibold text-primary-fg'
                : 'rounded border border-line bg-elevated px-3 py-1.5 text-sm text-muted hover:bg-surface'
            }
          >
            {r.label}
          </Link>
        ))}
      </nav>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="المبيعات المحصّلة">
          <Money cents={report.revenueCents} currency={ctx.currency} />
        </Stat>
        <Stat label="المصروفات">
          <Money cents={report.expensesCents} currency={ctx.currency} />
        </Stat>
        <Stat label="صافي الحركة" tone={report.netCents >= 0 ? 'positive' : 'negative'}>
          <Money cents={report.netCents} currency={ctx.currency} />
        </Stat>
        <Stat label="متوسط قيمة الطلب">
          <Money cents={report.averageOrderCents} currency={ctx.currency} />
        </Stat>
        <Stat label="طلبات مدفوعة">{report.paidOrders.toLocaleString('ar-EG')}</Stat>
        <Stat label="طلبات مفتوحة">{report.openOrders.toLocaleString('ar-EG')}</Stat>
        <Stat label="طلبات ملغاة">{report.cancelledOrders.toLocaleString('ar-EG')}</Stat>
        <Stat label="الخصومات">
          <Money cents={report.discountsCents} currency={ctx.currency} />
        </Stat>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>الأكثر مبيعًا</CardTitle>
          </CardHeader>
          <CardBody className="p-0">
            {report.topProducts.length === 0 ? (
              <EmptyState icon={BarChart3} title="لا توجد مبيعات في هذه الفترة" />
            ) : (
              <ul className="divide-y divide-line">
                {report.topProducts.map((p) => (
                  <li key={p.name} className="flex items-center justify-between gap-2 p-3 text-sm">
                    <span className="min-w-0 truncate">{p.name}</span>
                    <span className="flex shrink-0 items-center gap-3">
                      <span className="lb-numeric text-muted">{p.quantity}</span>
                      <Money cents={p.amountCents} currency={ctx.currency} className="font-semibold" />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>حسب طريقة الدفع</CardTitle>
          </CardHeader>
          <CardBody className="p-0">
            {report.byPaymentMethod.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted">لا توجد مدفوعات.</p>
            ) : (
              <ul className="divide-y divide-line">
                {report.byPaymentMethod.map((m) => (
                  <li key={m.method} className="flex items-center justify-between p-3 text-sm">
                    <span>{METHOD_LABELS[m.method] ?? m.method}</span>
                    <Money cents={m.amountCents} currency={ctx.currency} className="font-semibold" />
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>حسب الكاشير</CardTitle>
          </CardHeader>
          <CardBody className="p-0">
            {report.byCashier.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted">لا توجد بيانات.</p>
            ) : (
              <ul className="divide-y divide-line">
                {report.byCashier.map((c) => (
                  <li key={c.name} className="flex items-center justify-between p-3 text-sm">
                    <span className="min-w-0 truncate">{c.name}</span>
                    <span className="flex shrink-0 items-center gap-3">
                      <span className="lb-numeric text-muted">{c.count}</span>
                      <Money cents={c.amountCents} currency={ctx.currency} className="font-semibold" />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
