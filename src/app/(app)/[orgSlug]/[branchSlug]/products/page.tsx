import Link from 'next/link';
import { Package, Plus } from 'lucide-react';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { listProducts } from '@/modules/retail/products/service';
import { PageHeader } from '@/components/patterns/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Money } from '@/components/patterns/money';
import { EmptyState } from '@/components/patterns/states';
import { ProductSearch } from './product-search';

export const metadata = { title: 'المنتجات' };

export default async function ProductsPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; branchSlug: string };
  searchParams: { q?: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  const products = await listProducts(ctx, { search: searchParams.q });
  const base = `/${ctx.organizationSlug}/${ctx.branchSlug}`;
  const canManage = can(ctx, 'retail.product.manage');

  return (
    <div className="space-y-5">
      <PageHeader
        title="المنتجات"
        description={`${products.length} منتج في ${ctx.branchName}`}
        actions={
          canManage && (
            <Link href={`${base}/products/new`}>
              <Button size="sm">
                <Plus className="h-4 w-4" aria-hidden="true" />
                منتج جديد
              </Button>
            </Link>
          )
        }
      />

      <ProductSearch defaultValue={searchParams.q ?? ''} />

      <Card>
        {products.length === 0 ? (
          <EmptyState
            icon={Package}
            title={searchParams.q ? 'لا توجد نتائج' : 'لا توجد منتجات بعد'}
            description={
              searchParams.q
                ? 'جرّب كلمة بحث أخرى أو امسح البحث.'
                : 'ابدأ بإضافة أول منتج، وحدّد سعره وكميته الافتتاحية.'
            }
            {...(canManage && !searchParams.q
              ? { action: { label: 'إضافة منتج', href: `${base}/products/new` } }
              : {})}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">قائمة المنتجات</caption>
              <thead>
                <tr className="border-b border-line text-start text-xs text-muted">
                  <th scope="col" className="p-3 text-start font-medium">المنتج</th>
                  <th scope="col" className="p-3 text-start font-medium">التصنيف</th>
                  <th scope="col" className="p-3 text-start font-medium">السعر</th>
                  <th scope="col" className="p-3 text-start font-medium">المخزون</th>
                  <th scope="col" className="p-3 text-start font-medium">الحالة</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.id} className="border-b border-line last:border-0 hover:bg-surface">
                    <td className="p-3">
                      <span className="font-medium">{p.name}</span>
                      {p.variantCount > 1 && (
                        <span className="ms-2 text-xs text-muted">{p.variantCount} أنواع</span>
                      )}
                    </td>
                    <td className="p-3 text-muted">{p.categoryName ?? '—'}</td>
                    <td className="p-3">
                      <Money cents={p.priceFromCents} currency={ctx.currency} />
                    </td>
                    <td className="p-3 lb-numeric">{p.stock}</td>
                    <td className="p-3">
                      {!p.isActive ? (
                        <Badge tone="neutral">موقوف</Badge>
                      ) : p.stock <= 0 ? (
                        <Badge tone="danger">نفد</Badge>
                      ) : (
                        <Badge tone="success">متاح</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
