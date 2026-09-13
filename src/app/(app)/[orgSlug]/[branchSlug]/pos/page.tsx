import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { listPosCatalog } from '@/modules/retail/pos/service';
import { PosTerminal } from './pos-terminal';

export const metadata = { title: 'نقطة البيع' };

export default async function PosPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'retail.pos.use')) notFound();

  const catalog = await listPosCatalog(ctx);

  return (
    <PosTerminal
      catalog={catalog}
      currency={ctx.currency}
      organizationSlug={ctx.organizationSlug}
      branchSlug={ctx.branchSlug}
      canDiscount={can(ctx, 'retail.pos.discount')}
    />
  );
}
