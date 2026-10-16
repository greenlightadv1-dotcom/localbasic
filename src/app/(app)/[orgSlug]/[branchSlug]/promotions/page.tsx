import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { listMenu } from '@/modules/restaurant/menu/service';
import { listPromotions, listRewards } from '@/modules/restaurant/crm/service';
import { DataUnavailable } from '@/components/patterns/data-unavailable';
import { PageHeader } from '@/components/patterns/page-header';
import { PromotionsView } from './promotions-view';

export const metadata = { title: 'العروض والولاء' };
export const dynamic = 'force-dynamic';

export default async function PromotionsPage({ params }: { params: { orgSlug: string; branchSlug: string } }) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!ctx.enabledModules.includes('restaurant')) notFound();
  const canPromos = can(ctx, 'restaurant.promotion.manage');
  const canLoyalty = can(ctx, 'restaurant.loyalty.manage');
  const canRedeem = can(ctx, 'restaurant.pos.use');
  if (!canPromos && !canLoyalty) notFound();

  let promotions; let rewards; let menu;
  try {
    [promotions, rewards, menu] = await Promise.all([
      canPromos ? listPromotions(ctx) : Promise.resolve([]), listRewards(ctx), listMenu(ctx),
    ]);
  } catch (error) {
    return <DataUnavailable error={error} />;
  }

  const products = menu.filter((m) => m.isActive).map((m) => ({ id: m.id, name: m.name, categoryId: m.categoryId }));
  const categories = Array.from(new Map(menu.filter((m) => m.categoryId).map((m) => [m.categoryId!, m.categoryName ?? '—'])).entries()).map(([id, name]) => ({ id, name }));
  const variants = menu.filter((m) => m.isActive).flatMap((m) => m.variants.map((v) => ({ id: v.id, name: v.name && v.name !== m.name ? `${m.name} — ${v.name}` : m.name })));

  return (
    <div className="space-y-4">
      <PageHeader title="العروض والولاء" description="الساعة السعيدة، اشترِ X واحصل على Y، أكواد الخصم، ومكافآت نقاط الولاء." />
      <PromotionsView
        scope={{ organizationSlug: ctx.organizationSlug, branchSlug: ctx.branchSlug }}
        organizationId={ctx.organizationId}
        currency={ctx.currency}
        promotions={promotions}
        rewards={rewards}
        products={products}
        categories={categories}
        variants={variants}
        can={{ promotions: canPromos, loyalty: canLoyalty, redeem: canRedeem }}
      />
    </div>
  );
}
