import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { getRiskDashboard, listRiskLog } from '@/modules/restaurant/risk/service';
import { DataUnavailable } from '@/components/patterns/data-unavailable';
import { PageHeader } from '@/components/patterns/page-header';
import { RiskDashboard } from './risk-dashboard';

export const metadata = { title: 'مخاطر الكاشير' };
export const dynamic = 'force-dynamic';

const PERIODS = { '1': 1, '7': 7, '30': 30, '90': 90 } as const;

export default async function CashierRiskPage({ params, searchParams }: {
  params: { orgSlug: string; branchSlug: string };
  searchParams: { days?: string; user?: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'restaurant.audit.risk_view')) notFound();
  if (!ctx.enabledModules.includes('restaurant')) notFound();

  const days = PERIODS[(searchParams.days ?? '7') as keyof typeof PERIODS] ?? 7;
  const to = new Date(Date.now() + 60_000);
  const from = new Date(to.getTime() - days * 86_400_000);
  const user = searchParams.user && /^[0-9a-f-]{36}$/i.test(searchParams.user) ? searchParams.user : undefined;

  let rows; let log;
  try {
    [rows, log] = await Promise.all([getRiskDashboard(ctx, from, to), listRiskLog(ctx, { from, to, userId: user, limit: 200 })]);
  } catch (error) {
    return <DataUnavailable error={error} />;
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="مخاطر الكاشير"
        description="نقاط مخاطر لكل موظف: الإلغاء بعد الطباعة، فتح الدرج بدون بيع، إعادة الطباعة، الخصم فوق الحد والاسترداد. يُعلَّم الموظف عند 10 نقاط."
      />
      <RiskDashboard
        scope={{ organizationSlug: ctx.organizationSlug, branchSlug: ctx.branchSlug }}
        basePath={`/${ctx.organizationSlug}/${ctx.branchSlug}/audit/cashier-risk`}
        currency={ctx.currency}
        days={days}
        selectedUser={user ?? null}
        myUserId={ctx.userId}
        rows={rows}
        log={log}
        canReset={can(ctx, 'restaurant.audit.risk_reset')}
      />
    </div>
  );
}
