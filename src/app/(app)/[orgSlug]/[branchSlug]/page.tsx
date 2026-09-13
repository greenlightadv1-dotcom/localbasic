import { Suspense } from 'react';
import { Receipt, Users, Wallet, TrendingUp } from 'lucide-react';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { getDashboardSummary } from '@/modules/core/reports/service';
import { PageHeader } from '@/components/patterns/page-header';
import { Card, CardBody } from '@/components/ui/card';
import { Money } from '@/components/patterns/money';
import { Skeleton, EmptyState } from '@/components/patterns/states';
import { Alert } from '@/components/ui/alert';

export const metadata = { title: 'لوحة التحكم' };

function StatCard({
  label,
  children,
  icon: Icon,
}: {
  label: string;
  children: React.ReactNode;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Card>
      <CardBody className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-medium text-muted">{label}</p>
          <p className="truncate text-xl font-bold">{children}</p>
        </div>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-primary-soft">
          <Icon className="h-4 w-4 text-primary" />
        </span>
      </CardBody>
    </Card>
  );
}

async function Summary({ orgSlug, branchSlug }: { orgSlug: string; branchSlug: string }) {
  const ctx = await resolveTenantContext(orgSlug, branchSlug);
  const summary = await getDashboardSummary(ctx);

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {can(ctx, 'invoice.read') && (
        <StatCard label="مبيعات اليوم" icon={TrendingUp}>
          <Money cents={summary.salesTodayCents} currency={ctx.currency} />
        </StatCard>
      )}
      {can(ctx, 'invoice.read') && (
        <StatCard label="فواتير اليوم" icon={Receipt}>
          {summary.invoicesToday.toLocaleString('ar-EG')}
        </StatCard>
      )}
      {can(ctx, 'treasury.read') && (
        <StatCard label="رصيد الخزينة" icon={Wallet}>
          <Money cents={summary.treasuryBalanceCents} currency={ctx.currency} />
        </StatCard>
      )}
      {can(ctx, 'customer.read') && (
        <StatCard label="العملاء" icon={Users}>
          {summary.customerCount.toLocaleString('ar-EG')}
        </StatCard>
      )}
    </div>
  );
}

function SummarySkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-[88px]" />
      ))}
    </div>
  );
}

export default async function DashboardPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  const hasAnyStat =
    can(ctx, 'invoice.read') || can(ctx, 'treasury.read') || can(ctx, 'customer.read');

  return (
    <div className="space-y-5">
      <PageHeader
        title={`أهلًا بك في ${ctx.organizationName}`}
        description={`فرع ${ctx.branchName}`}
      />

      {hasAnyStat ? (
        <Suspense fallback={<SummarySkeleton />}>
          <Summary orgSlug={params.orgSlug} branchSlug={params.branchSlug} />
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

      {ctx.isOwner && (
        <Alert tone="info" title="مساحة العمل جاهزة">
          تم تجهيز الفرع الأول والأدوار الافتراضية والخزينة. ابدأ بإضافة المنتجات ثم افتح نقطة
          البيع.
        </Alert>
      )}
    </div>
  );
}
