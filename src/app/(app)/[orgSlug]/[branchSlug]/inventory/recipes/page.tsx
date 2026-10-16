import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { getRecipeBoard } from '@/modules/restaurant/costing/service';
import { DataUnavailable } from '@/components/patterns/data-unavailable';
import { PageHeader } from '@/components/patterns/page-header';
import { RecipeBoard } from './recipe-board';

export const metadata = { title: 'الوصفات وتكلفة الأصناف' };
export const dynamic = 'force-dynamic';

export default async function RecipesPage({ params }: { params: { orgSlug: string; branchSlug: string } }) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!ctx.enabledModules.includes('restaurant')) notFound();
  if (!can(ctx, 'inventory.read')) notFound();

  let board;
  try { board = await getRecipeBoard(ctx); } catch (error) { return <DataUnavailable error={error} />; }

  return (
    <div className="space-y-4">
      <PageHeader
        title="الوصفات وتكلفة الأصناف"
        description="اربط كل صنف في المنيو بخاماته بالكمية الدقيقة. التكلفة تُحسب من متوسط تكلفة كل خامة الآن، وتُخصم الخامات من المخزون تلقائيًا عند إرسال الطلب للمطبخ."
      />
      <RecipeBoard
        scope={{ organizationSlug: ctx.organizationSlug, branchSlug: ctx.branchSlug }}
        currency={ctx.currency}
        variants={board.variants}
        items={board.items}
        canEdit={can(ctx, 'inventory.manage')}
      />
    </div>
  );
}
