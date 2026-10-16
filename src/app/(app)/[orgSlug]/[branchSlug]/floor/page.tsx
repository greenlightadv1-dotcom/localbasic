import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { getFloorPlan, listWaitlist, type FloorPlan, type WaitlistEntry } from '@/modules/restaurant/floor/service';
import { DataUnavailable } from '@/components/patterns/data-unavailable';
import { PageHeader } from '@/components/patterns/page-header';
import { FloorView } from './floor-view';

export const metadata = { title: 'مخطط الصالة' };
// The floor is live: never a cached copy of who is sitting where.
export const dynamic = 'force-dynamic';

export default async function FloorPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'restaurant.table.read')) notFound();
  if (!ctx.enabledModules.includes('restaurant')) notFound();

  const canWaitlist = can(ctx, 'restaurant.waitlist.manage');
  let plan: FloorPlan;
  let waitlist: { open: WaitlistEntry[]; seatedToday: number } | null = null;
  try {
    [plan, waitlist] = await Promise.all([
      getFloorPlan(ctx),
      canWaitlist ? listWaitlist(ctx) : Promise.resolve(null),
    ]);
  } catch (error) {
    return <DataUnavailable error={error} />;
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="مخطط الصالة"
        description="حالة كل طاولة لحظيًا، ونقل ودمج وتقسيم الفواتير، وقائمة الانتظار."
      />
      <FloorView
        scope={{ organizationSlug: ctx.organizationSlug, branchSlug: ctx.branchSlug }}
        basePath={`/${ctx.organizationSlug}/${ctx.branchSlug}`}
        branchId={ctx.branchId}
        currency={ctx.currency}
        plan={plan}
        waitlist={waitlist}
        can={{
          design: can(ctx, 'restaurant.table.manage'),
          operate: can(ctx, 'restaurant.table.transfer'),
          setStatus: can(ctx, 'restaurant.table.status'),
          waitlist: canWaitlist,
          cashier: can(ctx, 'restaurant.pos.use'),
        }}
      />
    </div>
  );
}
