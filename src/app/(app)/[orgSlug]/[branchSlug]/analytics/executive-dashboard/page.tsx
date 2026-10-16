import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { getExecutiveData } from '@/modules/restaurant/analytics/service';
import { DataUnavailable } from '@/components/patterns/data-unavailable';
import { PageHeader } from '@/components/patterns/page-header';
import { ExecutiveDashboard } from './executive-dashboard';

export const metadata = { title: 'مركز القيادة التنفيذي' };
export const dynamic = 'force-dynamic';

const PERIODS = [1, 7, 30, 90] as const;

export default async function ExecutiveDashboardPage({ params, searchParams }: {
  params: { orgSlug: string; branchSlug: string }; searchParams: { days?: string; scope?: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!ctx.enabledModules.includes('restaurant')) notFound();
  if (!can(ctx, 'restaurant.analytics.executive')) notFound();

  const days = PERIODS.find((d) => String(d) === searchParams.days) ?? 30;
  const allBranches = searchParams.scope === 'all' && ctx.branches.length > 1;
  const to = new Date(Date.now() + 60_000);
  const from = new Date(to.getTime() - days * 86_400_000);

  let data;
  try { data = await getExecutiveData(ctx, { from, to, allBranches }); } catch (error) { return <DataUnavailable error={error} />; }

  return (
    <div className="space-y-4">
      <PageHeader
        title="مركز القيادة التنفيذي"
        description="الربح الفعلي بعد الخامات والهالك والعمالة، دوران المخزون، سلة المشتريات، سرعة الخدمة، وشرائح العملاء مع حملات الاسترجاع."
      />
      <ExecutiveDashboard
        scope={{ organizationSlug: ctx.organizationSlug, branchSlug: ctx.branchSlug }}
        basePath={`/${ctx.organizationSlug}/${ctx.branchSlug}/analytics/executive-dashboard`}
        currency={ctx.currency}
        timeZone={ctx.timezone || 'Africa/Cairo'}
        days={days}
        allBranches={allBranches}
        multiBranch={ctx.branches.length > 1}
        asOf={new Date().toISOString()}
        data={data}
        canCampaign={can(ctx, 'restaurant.campaign.send')}
      />
    </div>
  );
}
