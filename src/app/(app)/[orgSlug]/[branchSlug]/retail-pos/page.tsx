import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { listRetailPosCatalog } from '@/modules/retail/operations/service';
import { RetailPosTerminal } from './retail-pos-terminal';

export const metadata = { title: 'كاشير التجزئة' };

/**
 * The retail till (0111–0114): scanning with carton and scale labels, live
 * promotions, store credit and loyalty, and receipt returns with the manager
 * PIN on cash. Every figure on screen is a preview; the database prices the
 * sale again when it is submitted.
 */
export default async function RetailPosPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'retail.pos.use')) notFound();

  const catalog = await listRetailPosCatalog(ctx);

  return (
    <RetailPosTerminal
      catalog={catalog}
      currency={ctx.currency}
      scope={{ organizationSlug: ctx.organizationSlug, branchSlug: ctx.branchSlug }}
      permissions={{
        sell: can(ctx, 'invoice.create'),
        pay: can(ctx, 'payment.create'),
        discount: can(ctx, 'retail.pos.discount'),
        returns: can(ctx, 'retail.return.manage'),
      }}
    />
  );
}
