import { Boxes } from 'lucide-react';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { listStock } from '@/modules/retail/inventory/service';
import { PageHeader } from '@/components/patterns/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/patterns/states';
import { StockTable } from './stock-table';

export const metadata = { title: 'المخزون' };

export default async function InventoryPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; branchSlug: string };
  searchParams: { filter?: 'low' | 'out' };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  const rows = await listStock(ctx, { ...(searchParams.filter ? { only: searchParams.filter } : {}) });

  const lowCount = rows.filter((r) => r.status === 'low').length;
  const outCount = rows.filter((r) => r.status === 'out').length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="المخزون"
        description={`${ctx.branchName} — المخزون محسوب لهذا الفرع فقط`}
        actions={
          <div className="flex gap-2">
            {outCount > 0 && <Badge tone="danger">{outCount} نفد</Badge>}
            {lowCount > 0 && <Badge tone="warn">{lowCount} منخفض</Badge>}
          </div>
        }
      />

      <Card>
        {rows.length === 0 ? (
          <EmptyState
            icon={Boxes}
            title="لا توجد أصناف"
            description="أضف منتجات أولًا، وسيظهر مخزونها هنا لكل فرع على حدة."
          />
        ) : (
          <StockTable
            rows={rows}
            currency={ctx.currency}
            canAdjust={can(ctx, 'retail.inventory.adjust')}
            organizationSlug={ctx.organizationSlug}
            branchSlug={ctx.branchSlug}
          />
        )}
      </Card>
    </div>
  );
}
