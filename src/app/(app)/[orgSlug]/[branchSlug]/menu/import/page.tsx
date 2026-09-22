import Link from 'next/link';
import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { PageHeader } from '@/components/patterns/page-header';
import { Button } from '@/components/ui/button';
import { ImportWizard } from './wizard';

export const metadata = { title: 'استيراد الأصناف' };
export const dynamic = 'force-dynamic';

/**
 * Importing products into the restaurant catalog.
 *
 * Deliberately here, under the menu, and not under the Site Engine: the rows
 * become restaurant_products and restaurant_variants, which the POS, the
 * kitchen and the ordering flow all read. A site's menu section resolves those
 * same tables live, so an import updates every surface at once without any
 * content being copied into site content.
 */
export default async function MenuImportPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);

  // Reading the menu is the floor for even looking at this screen; the commit
  // step checks `restaurant.menu.manage` separately, server-side.
  if (!can(ctx, 'restaurant.menu.read')) notFound();

  const base = `/${ctx.organizationSlug}/${ctx.branchSlug}`;

  return (
    <div className="space-y-5">
      <PageHeader
        title="استيراد الأصناف"
        description="من ملف Excel أو CSV أو جدول Google عام. يضيف أصنافًا إلى منيو هذه المؤسسة."
        actions={
          <Link href={`${base}/menu`}>
            <Button variant="ghost" size="sm">
              رجوع للمنيو
            </Button>
          </Link>
        }
      />

      <ImportWizard
        orgSlug={ctx.organizationSlug}
        branchSlug={ctx.branchSlug}
        canManage={can(ctx, 'restaurant.menu.manage')}
      />
    </div>
  );
}
