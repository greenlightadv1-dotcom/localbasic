import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { listSuppliers, listPurchasableVariants } from '@/modules/retail/purchasing/service';
import { PageHeader } from '@/components/patterns/page-header';
import { NewPurchaseForm } from './new-purchase-form';

export const metadata = { title: 'أمر شراء جديد' };

export default async function NewPurchasePage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  // 404, not 403: a page someone may not use should not confirm it exists.
  if (!can(ctx, 'retail.purchase.manage')) notFound();

  const [suppliers, variants] = await Promise.all([
    listSuppliers(ctx),
    listPurchasableVariants(ctx),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="أمر شراء جديد"
        description="سجّل ما طلبته من المورد. لن يدخل المخزون إلا عند الاستلام."
      />
      <NewPurchaseForm
        suppliers={suppliers.map((s) => ({ id: s.id, name: s.name }))}
        variants={variants}
        currency={ctx.currency}
        organizationSlug={ctx.organizationSlug}
        branchSlug={ctx.branchSlug}
      />
    </div>
  );
}
