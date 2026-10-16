import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { getMenuPerformance } from '@/modules/restaurant/costing/service';
import { DataUnavailable } from '@/components/patterns/data-unavailable';
import { PageHeader } from '@/components/patterns/page-header';
import { MenuMatrix } from './menu-matrix';

export const metadata = { title: 'هندسة المنيو' };
export const dynamic = 'force-dynamic';

const PERIODS = [7, 30, 90] as const;

export default async function MenuMatrixPage({ params, searchParams }: {
  params: { orgSlug: string; branchSlug: string }; searchParams: { days?: string; scope?: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!ctx.enabledModules.includes('restaurant')) notFound();
  if (!can(ctx, 'report.read')) notFound();

  const days = PERIODS.find((d) => String(d) === searchParams.days) ?? 30;
  const allBranches = searchParams.scope === 'all' && ctx.branches.length > 1;
  const to = new Date(Date.now() + 60_000);
  const from = new Date(to.getTime() - days * 86_400_000);

  let rows;
  try { rows = await getMenuPerformance(ctx, from, to, allBranches); } catch (error) { return <DataUnavailable error={error} />; }

  return (
    <div className="space-y-4">
      <PageHeader
        title="هندسة المنيو"
        description="كل صنف حسب شعبيته (حصته من الكميات المباعة) وربحيته (هامش الحصة من وصفته). الطلبات المكتملة فقط، بسعر المنيو قبل خصومات الفاتورة."
      />
      <MenuMatrix
        basePath={`/${ctx.organizationSlug}/${ctx.branchSlug}/analytics/menu-matrix`}
        currency={ctx.currency}
        days={days}
        allBranches={allBranches}
        multiBranch={ctx.branches.length > 1}
        rows={rows}
      />
    </div>
  );
}
