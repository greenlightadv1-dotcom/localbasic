'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, Boxes, PackageX, Search, Wallet } from 'lucide-react';
import { Input, Select } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/patterns/states';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/cn';
import type { RetailPosCatalog, RetailPosItem } from '@/modules/retail/operations/service';

const qty = (n: number) => new Intl.NumberFormat('ar-EG', { maximumFractionDigits: 3 }).format(n);
const UNIT: Record<string, string> = { piece: 'قطعة', kg: 'كجم', gram: 'جم', litre: 'لتر', metre: 'متر', box: 'علبة', pack: 'عبوة' };
type Level = 'all' | 'low' | 'out';

function level(i: RetailPosItem): 'out' | 'low' | 'ok' {
  if (i.stock <= 0) return 'out';
  if (i.reorderPoint > 0 && i.stock <= i.reorderPoint) return 'low';
  return 'ok';
}

/** Current quantities in this branch, searchable and filterable, with value at cost. */
export function StockLevels({ catalog, currency }: { catalog: RetailPosCatalog; currency: string }) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [filter, setFilter] = useState<Level>('all');
  const money = (c: number) => formatMoney(c, currency);
  const categoryName = useMemo(() => new Map(catalog.categories.map((c) => [c.id, c.name])), [catalog.categories]);

  const summary = useMemo(() => ({
    items: catalog.items.length,
    low: catalog.items.filter((i) => level(i) === 'low').length,
    out: catalog.items.filter((i) => level(i) === 'out').length,
    value: catalog.items.reduce((s, i) => s + Math.round(Math.max(i.stock, 0) * i.costCents), 0),
  }), [catalog.items]);

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return catalog.items.filter((i) =>
      (!category || i.categoryId === category)
      && (filter === 'all' || level(i) === filter)
      && (!term || i.productName.toLowerCase().includes(term) || i.variantName.toLowerCase().includes(term)
        || i.sku?.toLowerCase().includes(term) || i.barcode?.includes(term)));
  }, [catalog.items, category, filter, search]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={Boxes} label="أصناف" value={qty(summary.items)} />
        <Stat icon={AlertTriangle} label="تحت حد الطلب" value={qty(summary.low)} tone="warn" onClick={() => setFilter('low')} />
        <Stat icon={PackageX} label="نفدت" value={qty(summary.out)} tone="danger" onClick={() => setFilter('out')} />
        <Stat icon={Wallet} label="قيمة المخزون بالتكلفة" value={money(summary.value)} />
      </div>

      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-[14rem] flex-1">
          <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-muted" aria-hidden="true" />
          <Input aria-label="بحث" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ابحث بالاسم أو SKU أو الباركود" className="ps-9" />
        </div>
        <Select aria-label="القسم" value={category} onChange={(e) => setCategory(e.target.value)} className="w-auto">
          <option value="">كل الأقسام</option>
          {catalog.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Select aria-label="الحالة" value={filter} onChange={(e) => setFilter(e.target.value as Level)} className="w-auto">
          <option value="all">كل الأرصدة</option>
          <option value="low">تحت حد الطلب</option>
          <option value="out">نفدت</option>
        </Select>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-line bg-elevated">
          <EmptyState icon={Search} title="لا أصناف مطابقة" description="غيّر البحث أو الفلتر." />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-elevated">
          <table className="w-full min-w-[44rem] text-sm">
            <thead className="bg-surface text-xs text-muted">
              <tr>
                <th className="px-3 py-2 text-start font-medium">الصنف</th>
                <th className="px-3 py-2 text-start font-medium">SKU / باركود</th>
                <th className="px-3 py-2 text-start font-medium">القسم</th>
                <th className="px-3 py-2 text-start font-medium">الرصيد</th>
                <th className="px-3 py-2 text-start font-medium">حد الطلب</th>
                <th className="px-3 py-2 text-start font-medium">الحالة</th>
                <th className="px-3 py-2 text-start font-medium">القيمة</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 500).map((i) => {
                const l = level(i);
                return (
                  <tr key={i.variantId} className="border-t border-line">
                    <td className="px-3 py-2">{i.productName}{i.variantName !== 'default' && <span className="text-muted"> — {i.variantName}</span>}</td>
                    <td className="px-3 py-2 text-xs text-muted" dir="ltr">{[i.sku, i.barcode].filter(Boolean).join(' · ') || '—'}</td>
                    <td className="px-3 py-2 text-muted">{i.categoryId ? categoryName.get(i.categoryId) ?? '—' : '—'}</td>
                    <td className={cn('px-3 py-2 lb-numeric font-semibold', l === 'out' && 'text-danger', l === 'low' && 'text-warn')}>
                      {qty(i.stock)} <span className="text-xs font-normal text-muted">{UNIT[i.unit] ?? ''}</span>
                    </td>
                    <td className="px-3 py-2 lb-numeric text-muted">{i.reorderPoint > 0 ? qty(i.reorderPoint) : '—'}</td>
                    <td className="px-3 py-2">
                      <Badge tone={l === 'out' ? 'danger' : l === 'low' ? 'warn' : 'success'}>{l === 'out' ? 'نفد' : l === 'low' ? 'منخفض' : 'متوفر'}</Badge>
                    </td>
                    <td className="px-3 py-2 lb-numeric">{money(Math.round(Math.max(i.stock, 0) * i.costCents))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length > 500 && <p className="border-t border-line px-3 py-2 text-xs text-muted">يظهر أول 500 من {qty(rows.length)}؛ ضيّق البحث.</p>}
        </div>
      )}
    </div>
  );
}

function Stat({ icon: Icon, label, value, tone, onClick }: {
  icon: typeof Boxes; label: string; value: string; tone?: 'warn' | 'danger'; onClick?: () => void;
}) {
  const body = (
    <>
      <Icon className={cn('h-5 w-5', tone === 'warn' ? 'text-warn' : tone === 'danger' ? 'text-danger' : 'text-primary')} aria-hidden="true" />
      <span className="text-xs text-muted">{label}</span>
      <span className="lb-numeric text-lg font-bold">{value}</span>
    </>
  );
  const cls = 'flex flex-col items-start gap-1 rounded-lg border border-line bg-elevated p-3 text-start';
  return onClick
    ? <button type="button" onClick={onClick} className={cn(cls, 'transition-colors hover:border-primary')}>{body}</button>
    : <div className={cls}>{body}</div>;
}
