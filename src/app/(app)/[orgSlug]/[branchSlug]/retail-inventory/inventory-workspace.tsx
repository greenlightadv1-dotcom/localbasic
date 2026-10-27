'use client';

import { useState } from 'react';
import { ArrowLeftRight, Boxes, ShoppingCart } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';
import type {
  BranchOption, ReorderSuggestion, RetailPosCatalog, TransferView,
} from '@/modules/retail/operations/service';
import { TransferBoard } from './transfer-board';
import { ReorderPanel } from './reorder-panel';
import { StockLevels } from './stock-levels';

export type InventoryTab = 'transfers' | 'reorder' | 'stock';
export type Scope = { organizationSlug: string; branchSlug: string };
export type InventoryPermissions = { transfer: boolean; approve: boolean; purchaseRead: boolean; purchaseManage: boolean };

/**
 * Three tabs on one page. The active tab is mirrored into ?tab= so a link or
 * a refresh lands where the person was, without a server round trip per click.
 */
export function InventoryWorkspace({
  initialTab, scope, branchId, currency, timezone, branches, transfers, catalog, suggestions, suppliers, permissions,
}: {
  initialTab: InventoryTab;
  scope: Scope;
  branchId: string;
  currency: string;
  timezone: string;
  branches: BranchOption[];
  transfers: TransferView[];
  catalog: RetailPosCatalog;
  suggestions: ReorderSuggestion[];
  suppliers: Record<string, string>;
  permissions: InventoryPermissions;
}) {
  const [tab, setTab] = useState<InventoryTab>(initialTab);

  function select(next: InventoryTab) {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', next);
    window.history.replaceState(null, '', url);
  }

  const openTransfers = transfers.filter((t) =>
    (t.status === 'requested' && t.direction === 'outgoing')
    || (t.status === 'approved' && t.direction === 'outgoing')
    || (t.status === 'in_transit' && t.direction === 'incoming')).length;
  const low = catalog.items.filter((i) => i.reorderPoint > 0 && i.stock <= i.reorderPoint).length;

  const tabs: { key: InventoryTab; label: string; icon: typeof Boxes; count?: number; hidden?: boolean }[] = [
    { key: 'transfers', label: 'التحويلات', icon: ArrowLeftRight, count: openTransfers },
    { key: 'reorder', label: 'إعادة الطلب', icon: ShoppingCart, count: suggestions.length, hidden: !permissions.purchaseRead },
    { key: 'stock', label: 'أرصدة المخزون', icon: Boxes, count: low },
  ];

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="أقسام المخزون" className="flex gap-1 overflow-x-auto border-b border-line">
        {tabs.filter((t) => !t.hidden).map(({ key, label, icon: Icon, count }) => (
          <button
            key={key}
            role="tab"
            type="button"
            id={`tab-${key}`}
            aria-selected={tab === key}
            aria-controls={`panel-${key}`}
            onClick={() => select(key)}
            className={cn(
              '-mb-px flex shrink-0 items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
              tab === key ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-fg',
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {label}
            {count ? <Badge tone={tab === key ? 'info' : 'neutral'}>{count}</Badge> : null}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'transfers' && (
          <TransferBoard
            scope={scope} branchId={branchId} timezone={timezone} branches={branches}
            transfers={transfers} catalog={catalog} permissions={permissions}
          />
        )}
        {tab === 'reorder' && permissions.purchaseRead && (
          <ReorderPanel scope={scope} currency={currency} suggestions={suggestions} suppliers={suppliers} canGenerate={permissions.purchaseManage} />
        )}
        {tab === 'stock' && <StockLevels catalog={catalog} currency={currency} />}
      </div>
    </div>
  );
}
