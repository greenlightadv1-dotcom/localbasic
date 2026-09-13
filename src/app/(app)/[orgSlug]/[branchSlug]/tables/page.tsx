import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { listFloor, listSections } from '@/modules/restaurant/tables/service';
import { PageHeader } from '@/components/patterns/page-header';
import { TablesManager } from './tables-manager';

export const metadata = { title: 'الطاولات' };

export default async function TablesPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'restaurant.table.read')) notFound();

  const [floor, sections] = await Promise.all([listFloor(ctx), listSections(ctx)]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="الطاولات و QR"
        description={`${floor.length} طاولة في ${ctx.branchName}. كل طاولة لها رمز QR خاص بها.`}
      />
      <TablesManager
        floor={floor}
        sections={sections}
        currency={ctx.currency}
        canManage={can(ctx, 'restaurant.table.manage')}
        canSetStatus={can(ctx, 'restaurant.table.status')}
        basePath={`/${ctx.organizationSlug}/${ctx.branchSlug}`}
        organizationSlug={ctx.organizationSlug}
        branchSlug={ctx.branchSlug}
      />
    </div>
  );
}
