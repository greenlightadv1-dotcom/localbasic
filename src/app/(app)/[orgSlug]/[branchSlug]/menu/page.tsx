import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { listMenu, listCategories } from '@/modules/restaurant/menu/service';
import { PageHeader } from '@/components/patterns/page-header';
import { MenuManager } from './menu-manager';

export const metadata = { title: 'المنيو' };

export default async function MenuPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'restaurant.menu.read')) notFound();

  const [menu, categories] = await Promise.all([listMenu(ctx), listCategories(ctx)]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="المنيو"
        description={`المنيو مشترك بين الفروع، والتوافر يُضبط لكل فرع على حدة (${ctx.branchName}).`}
      />
      <MenuManager
        menu={menu}
        categories={categories}
        currency={ctx.currency}
        canManage={can(ctx, 'restaurant.menu.manage')}
        organizationSlug={ctx.organizationSlug}
        branchSlug={ctx.branchSlug}
      />
    </div>
  );
}
