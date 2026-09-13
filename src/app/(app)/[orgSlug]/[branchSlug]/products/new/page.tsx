import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { listCategories } from '@/modules/retail/products/service';
import { PageHeader } from '@/components/patterns/page-header';
import { NewProductForm } from './new-product-form';

export const metadata = { title: 'منتج جديد' };

export default async function NewProductPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  // The page is hidden from navigation without this permission; reaching it by
  // URL yields a 404, and the action would refuse regardless.
  if (!can(ctx, 'retail.product.manage')) notFound();

  const categories = await listCategories(ctx);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader title="منتج جديد" description="أضف المنتج وسعره وكميته الافتتاحية." />
      <NewProductForm
        categories={categories}
        currency={ctx.currency}
        organizationSlug={ctx.organizationSlug}
        branchSlug={ctx.branchSlug}
      />
    </div>
  );
}
