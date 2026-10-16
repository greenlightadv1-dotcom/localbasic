import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { getPurchasingBoard } from '@/modules/restaurant/purchasing/service';
import { DataUnavailable } from '@/components/patterns/data-unavailable';
import { PageHeader } from '@/components/patterns/page-header';
import { PurchasingBoard } from './purchasing-board';

export const metadata = { title: 'المشتريات وتنبيهات المخزون' };
export const dynamic = 'force-dynamic';

export default async function PurchasingPage({ params }: { params: { orgSlug: string; branchSlug: string } }) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!ctx.enabledModules.includes('restaurant')) notFound();
  if (!can(ctx, 'inventory.read') && !can(ctx, 'inventory.purchase')) notFound();

  let board;
  try { board = await getPurchasingBoard(ctx); } catch (error) { return <DataUnavailable error={error} />; }

  return (
    <div className="space-y-4">
      <PageHeader
        title="المشتريات وتنبيهات المخزون"
        description="خامات المخزن التي وصلت للحد الأدنى، وطلبات الشراء بضغطة واحدة لكل مورد، والاستلام الذي يُدخل الكميات ويحدّث متوسط التكلفة."
      />
      <PurchasingBoard
        scope={{ organizationSlug: ctx.organizationSlug, branchSlug: ctx.branchSlug }}
        currency={ctx.currency}
        {...board}
        can={{ purchase: can(ctx, 'inventory.purchase'), receive: can(ctx, 'inventory.purchase') && can(ctx, 'inventory.stock_in'), manage: can(ctx, 'inventory.manage') }}
      />
    </div>
  );
}
