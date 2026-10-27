import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { PageHeader } from '@/components/patterns/page-header';
import {
  getReorderSuggestions,
  listBranchTransfers,
  listOrgBranches,
  listRetailPosCatalog,
  listSupplierNames,
} from '@/modules/retail/operations/service';
import { InventoryWorkspace, type InventoryTab } from './inventory-workspace';

export const metadata = { title: 'مخزون التجزئة والتحويلات' };

const TABS: InventoryTab[] = ['transfers', 'reorder', 'stock'];

/**
 * Retail inventory for the current branch (0111/0112): the branch-to-branch
 * transfer board, auto-reorder into draft purchase orders, and stock levels.
 * Each tab loads only if the member may see it; every write re-checks the
 * exact branch rule in the database.
 */
export default async function RetailInventoryPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; branchSlug: string };
  searchParams: { tab?: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'retail.inventory.read')) notFound();

  const canPurchaseRead = can(ctx, 'retail.purchase.read');
  const branches = await listOrgBranches(ctx);
  const [transfers, catalog, suggestions, suppliers] = await Promise.all([
    listBranchTransfers(ctx, branches),
    listRetailPosCatalog(ctx),
    canPurchaseRead ? getReorderSuggestions(ctx) : Promise.resolve([]),
    canPurchaseRead ? listSupplierNames(ctx) : Promise.resolve({} as Record<string, string>),
  ]);

  const tab = TABS.includes(searchParams.tab as InventoryTab) ? (searchParams.tab as InventoryTab) : 'transfers';

  return (
    <div className="space-y-5">
      <PageHeader
        title="المخزون والتحويلات"
        description={`فرع ${ctx.branchName}: تحويلات بين الفروع، إعادة الطلب التلقائي، وأرصدة الأصناف.`}
      />
      <InventoryWorkspace
        initialTab={tab}
        scope={{ organizationSlug: ctx.organizationSlug, branchSlug: ctx.branchSlug }}
        branchId={ctx.branchId}
        currency={ctx.currency}
        timezone={ctx.timezone}
        branches={branches}
        transfers={transfers}
        catalog={catalog}
        suggestions={suggestions}
        suppliers={suppliers}
        permissions={{
          transfer: can(ctx, 'retail.inventory.transfer'),
          approve: can(ctx, 'retail.transfer.approve'),
          purchaseRead: canPurchaseRead,
          purchaseManage: can(ctx, 'retail.purchase.manage'),
        }}
      />
    </div>
  );
}
