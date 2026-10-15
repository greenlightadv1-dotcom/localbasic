import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { getStockOverview } from '@/modules/restaurant/inventory/service';
import { listMenu } from '@/modules/restaurant/menu/service';
import { PageHeader } from '@/components/patterns/page-header';
import { DataUnavailable } from '@/components/patterns/data-unavailable';
import { StockManager } from './stock-manager';

export const metadata = { title: 'المخزن والخامات' };
export const dynamic = 'force-dynamic';

export default async function StockPage({ params }: { params: { orgSlug: string; branchSlug: string } }) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'inventory.read')) notFound();
  if (!ctx.enabledModules.includes('restaurant')) notFound();

  let overview: Awaited<ReturnType<typeof getStockOverview>>;
  try {
    overview = await getStockOverview(ctx);
  } catch (error) {
    return (
      <div className="space-y-5">
        <PageHeader title="المخزن والخامات" />
        <DataUnavailable error={error} />
      </div>
    );
  }
  const menu = can(ctx, 'restaurant.menu.read') ? await listMenu(ctx) : [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="المخزن والخامات"
        description={`الخامات بالجرام والمللي والقطعة · ${ctx.branchName}`}
      />
      <StockManager
        scope={{ organizationSlug: ctx.organizationSlug, branchSlug: ctx.branchSlug }}
        branchId={ctx.branchId}
        currency={ctx.currency}
        overview={overview}
        products={menu.map((p) => ({ id: p.id, name: p.name, category: p.categoryName, variants: p.variants.map((v) => ({ id: v.id, name: v.name })) }))}
        can={{
          manage: can(ctx, 'inventory.manage'),
          stockIn: can(ctx, 'inventory.stock_in'),
          issue: can(ctx, 'inventory.issue'),
          waste: can(ctx, 'inventory.waste'),
          adjust: can(ctx, 'inventory.adjust'),
        }}
      />
    </div>
  );
}
