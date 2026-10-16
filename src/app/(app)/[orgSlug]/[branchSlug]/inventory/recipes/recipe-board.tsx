'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ChefHat, Plus, Search, Trash2 } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input, Select } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/cn';
import { foodCostRatio, pricing, recipeCost } from '@/modules/restaurant/costing/calc';
import type { CostedVariant, CostItem } from '@/modules/restaurant/costing/service';
import { BASE_UNIT_LABELS, INPUT_UNITS, costPerPurchaseUnit, formatQty, toBase, type InputUnit } from '@/modules/restaurant/inventory/units';
import { saveRecipeAction } from '../../stock/actions';

type Scope = { organizationSlug: string; branchSlug: string };
type DraftLine = { key: string; itemId: string; amount: string; unit: InputUnit; locationKind: '' | 'kitchen' | 'bar' };
const TARGET = 0.3;

const pct = (r: number | null) => (r === null ? '—' : `${(r * 100).toLocaleString('ar-EG', { maximumFractionDigits: 1 })}%`);
const tone = (r: number | null) => (r === null ? 'neutral' : r > 0.4 ? 'danger' : r > TARGET ? 'warn' : 'success') as 'neutral' | 'danger' | 'warn' | 'success';

/**
 * Menu items on the left with their live cost, price and food-cost %; the
 * selected item's bill of materials on the right, priced line by line as the
 * manager types. Saving replaces the recipe (audited before/after, 0102).
 */
export function RecipeBoard({ scope, currency, variants, items, canEdit }: {
  scope: Scope; currency: string; variants: CostedVariant[]; items: CostItem[]; canEdit: boolean;
}) {
  const money = (c: number) => formatMoney(Math.round(c), currency);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'none' | 'high' | 'missing'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(variants[0]?.variantId ?? null);
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const shown = variants.filter((v) => {
    const label = `${v.productName} ${v.variantName} ${v.categoryName ?? ''}`;
    if (query.trim() && !label.includes(query.trim())) return false;
    const r = foodCostRatio(v.costCents, v.priceCents);
    if (filter === 'none') return v.lineCount === 0;
    if (filter === 'high') return v.lineCount > 0 && r !== null && r > TARGET;
    if (filter === 'missing') return v.missingCost;
    return true;
  });
  const withRecipe = variants.filter((v) => v.lineCount > 0);
  const avgRatio = withRecipe.length
    ? withRecipe.reduce((s, v) => s + (foodCostRatio(v.costCents, v.priceCents) ?? 0), 0) / withRecipe.length : null;
  const selected = variants.find((v) => v.variantId === selectedId) ?? null;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card><CardBody><p className="text-xs text-muted">أصناف لها وصفة</p><p className="lb-numeric text-2xl font-bold">{withRecipe.length} / {variants.length}</p></CardBody></Card>
        <Card><CardBody><p className="text-xs text-muted">متوسط نسبة التكلفة</p><p className="lb-numeric text-2xl font-bold">{pct(avgRatio)}</p><p className="text-xs text-muted">الهدف {pct(TARGET)} أو أقل</p></CardBody></Card>
        <Card><CardBody><p className="text-xs text-muted">أصناف فوق الهدف</p><p className="lb-numeric text-2xl font-bold">{withRecipe.filter((v) => (foodCostRatio(v.costCents, v.priceCents) ?? 0) > TARGET).length}</p></CardBody></Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card>
          <CardHeader className="space-y-2">
            <CardTitle>أصناف المنيو</CardTitle>
            <div className="relative">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
              <Input aria-label="بحث" placeholder="ابحث عن صنف…" className="ps-9" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div className="flex flex-wrap gap-1">
              {([['all', 'الكل'], ['none', 'بدون وصفة'], ['high', 'تكلفة عالية'], ['missing', 'خامة بلا تكلفة']] as const).map(([k, l]) => (
                <button key={k} type="button" onClick={() => setFilter(k)}
                  className={cn('rounded border px-2 py-1 text-xs', filter === k ? 'border-primary bg-primary-soft text-primary' : 'border-line')}>{l}</button>
              ))}
            </div>
          </CardHeader>
          <CardBody className="max-h-[70vh] overflow-y-auto p-0">
            {shown.length === 0 ? <p className="p-5 text-center text-sm text-muted">لا أصناف.</p> : (
              <ul className="divide-y divide-line" data-testid="recipe-variants">
                {shown.map((v) => {
                  const r = foodCostRatio(v.costCents, v.priceCents);
                  return (
                    <li key={v.variantId}>
                      <button type="button" onClick={() => setSelectedId(v.variantId)}
                        className={cn('flex w-full items-center justify-between gap-2 p-3 text-start text-sm', selectedId === v.variantId && 'bg-primary-soft')}>
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{v.productName}{v.variantName !== 'default' && v.variantName !== v.productName ? ` — ${v.variantName}` : ''}</span>
                          <span className="text-xs text-muted">{v.categoryName ?? 'بدون قسم'} · {v.lineCount ? `${v.lineCount} خامة` : 'بدون وصفة'}</span>
                        </span>
                        <span className="shrink-0 text-end">
                          <span className="lb-numeric block text-xs text-muted">{money(v.costCents)} / {money(v.priceCents)}</span>
                          {v.lineCount > 0 ? <Badge tone={tone(r)}>{pct(r)}</Badge> : <Badge tone="neutral">—</Badge>}
                          {v.missingCost && <AlertTriangle className="ms-1 inline h-3.5 w-3.5 text-warn" aria-label="خامة بلا تكلفة" />}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>

        {selected ? (
          <RecipeEditor key={selected.variantId} scope={scope} variant={selected} items={items} itemById={itemById} money={money} canEdit={canEdit} />
        ) : <Card><CardBody><p className="text-sm text-muted">اختر صنفًا.</p></CardBody></Card>}
      </div>
    </div>
  );
}

function RecipeEditor({ scope, variant, items, itemById, money, canEdit }: {
  scope: Scope; variant: CostedVariant; items: CostItem[]; itemById: Map<string, CostItem>; money: (c: number) => string; canEdit: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const initial = (): DraftLine[] => variant.lines.map((l) => {
    const unit = itemById.get(l.itemId)?.unit ?? 'g';
    return { key: crypto.randomUUID(), itemId: l.itemId, amount: String(l.qty), unit, locationKind: l.locationKind ?? '' };
  });
  const [lines, setLines] = useState<DraftLine[]>(initial);
  const [portions, setPortions] = useState('10');

  const base = lines.map((l) => {
    const item = itemById.get(l.itemId);
    const amount = Number(l.amount);
    return { line: l, item, qty: item && amount > 0 ? toBase(amount, item.unit, l.unit) : 0 };
  });
  const costs = new Map(items.map((i) => [i.id, i.avgCostCents]));
  const live = recipeCost(base.filter((b) => b.item && b.qty > 0).map((b) => ({ itemId: b.line.itemId, qty: b.qty })), costs);
  const p = pricing(live.costCents, variant.priceCents, TARGET);
  const dirty = JSON.stringify(base.map((b) => [b.line.itemId, b.qty, b.line.locationKind])) !==
                JSON.stringify(variant.lines.map((l) => [l.itemId, l.qty, l.locationKind ?? '']));

  function save() {
    const valid = base.filter((b) => b.item);
    if (valid.some((b) => !(b.qty > 0))) { toast.error('كل خامة تحتاج كمية أكبر من صفر'); return; }
    if (new Set(valid.map((b) => b.line.itemId)).size !== valid.length) { toast.error('الخامة مكررة في الوصفة'); return; }
    start(async () => {
      const r = await saveRecipeAction(scope, {
        variantId: variant.variantId,
        lines: valid.map((b) => ({ itemId: b.line.itemId, qty: b.qty, locationKind: b.line.locationKind || null })),
      });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success('تم حفظ الوصفة'); router.refresh();
    });
  }

  const n = Math.max(Number(portions) || 0, 0);
  return (
    <Card data-testid="recipe-editor">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ChefHat className="h-5 w-5" aria-hidden="true" /> {variant.productName}{variant.variantName !== 'default' && variant.variantName !== variant.productName ? ` — ${variant.variantName}` : ''}</CardTitle>
      </CardHeader>
      <CardBody className="space-y-4">
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <div className="rounded bg-surface p-2"><dt className="text-xs text-muted">التكلفة للحصة</dt><dd className="lb-numeric font-bold" data-testid="live-cost">{money(live.costCents)}</dd></div>
          <div className="rounded bg-surface p-2"><dt className="text-xs text-muted">سعر البيع</dt><dd className="lb-numeric font-bold">{money(variant.priceCents)}</dd></div>
          <div className="rounded bg-surface p-2"><dt className="text-xs text-muted">الهامش</dt><dd className={cn('lb-numeric font-bold', p.marginCents < 0 && 'text-danger')}>{money(p.marginCents)}</dd></div>
          <div className="rounded bg-surface p-2"><dt className="text-xs text-muted">نسبة التكلفة</dt><dd><Badge tone={tone(p.ratio)}>{pct(p.ratio)}</Badge></dd></div>
        </dl>
        {p.ratio !== null && p.ratio > TARGET && p.suggestedPriceCents !== null && (
          <p className="text-xs text-muted">لتصل نسبة التكلفة إلى {pct(TARGET)} يكون السعر نحو <span className="lb-numeric">{money(p.suggestedPriceCents)}</span>.</p>
        )}
        {live.missing.length > 0 && (
          <p className="flex items-center gap-1 text-xs text-warn"><AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> خامات لم تُسجَّل تكلفتها بعد (أول استلام يحددها): {live.missing.map((id) => itemById.get(id)?.name).join('، ')}</p>
        )}

        <div className="space-y-2">
          {lines.length === 0 && <p className="text-sm text-muted">لا خامات بعد. بدون وصفة لا يُخصم شيء من المخزون لهذا الصنف.</p>}
          {base.map(({ line, item, qty }, idx) => (
            <div key={line.key} className="grid grid-cols-[minmax(0,1fr)_6rem_5.5rem_auto] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_6rem_5.5rem_6rem_6rem_auto]">
              <Select aria-label="الخامة" value={line.itemId} disabled={!canEdit}
                onChange={(e) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, itemId: e.target.value, unit: itemById.get(e.target.value)?.unit ?? 'g' } : x)))}>
                <option value="">— الخامة —</option>
                {items.filter((i) => i.isActive || i.id === line.itemId).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </Select>
              <Input aria-label="الكمية" dir="ltr" inputMode="decimal" value={line.amount} disabled={!canEdit}
                onChange={(e) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, amount: e.target.value } : x)))} data-testid="line-qty" />
              <Select aria-label="الوحدة" value={line.unit} disabled={!canEdit || !item}
                onChange={(e) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, unit: e.target.value as InputUnit } : x)))}>
                {(item ? INPUT_UNITS[item.unit] : INPUT_UNITS.g).map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
              </Select>
              <Select aria-label="يُصرف من" className="hidden sm:block" value={line.locationKind} disabled={!canEdit}
                onChange={(e) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, locationKind: e.target.value as DraftLine['locationKind'] } : x)))}>
                <option value="">محطة الصنف</option>
                <option value="kitchen">المطبخ</option>
                <option value="bar">البار</option>
              </Select>
              <span className="lb-numeric hidden text-end text-xs text-muted sm:block">{item && qty > 0 ? money(qty * item.avgCostCents) : '—'}</span>
              {canEdit && <Button size="sm" variant="ghost" aria-label="حذف" onClick={() => setLines((ls) => ls.filter((_, i) => i !== idx))}><Trash2 className="h-4 w-4" /></Button>}
            </div>
          ))}
          {canEdit && (
            <Button size="sm" variant="ghost" onClick={() => setLines((ls) => [...ls, { key: crypto.randomUUID(), itemId: '', amount: '', unit: 'g', locationKind: '' }])} data-testid="add-line">
              <Plus className="h-4 w-4" aria-hidden="true" /> خامة
            </Button>
          )}
        </div>

        {base.some((b) => b.item && b.qty > 0) && (
          <div className="rounded border border-line p-2 text-xs">
            <div className="mb-1 flex items-center gap-2">
              <span>ما يُخصم من المخزون لكل</span>
              <Input aria-label="عدد الحصص" dir="ltr" inputMode="numeric" className="h-7 w-16 text-center" value={portions} onChange={(e) => setPortions(e.target.value)} />
              <span>حصة:</span>
            </div>
            <ul className="space-y-0.5 text-muted">
              {base.filter((b) => b.item && b.qty > 0).map((b) => (
                <li key={b.line.key}>{b.item!.name}: <span className="lb-numeric">{formatQty(b.qty * n, b.item!.unit)}</span>
                  <span className="lb-numeric"> · {money(costPerPurchaseUnit(b.item!.avgCostCents, b.item!.unit))} / {b.item!.unit === 'pc' ? BASE_UNIT_LABELS.pc : b.item!.unit === 'g' ? 'كجم' : 'لتر'}</span></li>
              ))}
            </ul>
          </div>
        )}

        {canEdit && (
          <div className="flex gap-2">
            <Button size="sm" disabled={pending || !dirty} onClick={save} data-testid="save-recipe">حفظ الوصفة</Button>
            {dirty && <Button size="sm" variant="ghost" onClick={() => setLines(initial())}>تراجع</Button>}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
