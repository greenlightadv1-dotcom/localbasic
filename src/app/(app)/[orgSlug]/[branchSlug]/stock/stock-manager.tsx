'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Boxes, ClipboardList, PackagePlus, Scale, Soup, Trash2, Truck } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Field, Input, Select } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { EmptyState } from '@/components/patterns/states';
import { useApproval } from '@/components/patterns/approval-dialog';
import { LinesEditor, newLine, toBaseLines, defaultInputUnit, type DraftLine } from '@/components/inventory/lines-editor';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { formatMoney } from '@/lib/money';
import {
  costPerPurchaseUnit, costToBase, formatQty, INPUT_UNITS, LOCATION_LABELS, toBase,
  TRANSFER_STATUS_LABELS, WASTE_REASON_LABELS, WASTE_REASONS, BASE_UNIT_LABELS, type BaseUnit, type InputUnit,
} from '@/modules/restaurant/inventory/units';
import type { StockOverview, InventoryItem } from '@/modules/restaurant/inventory/service';
import {
  adjustAction, cancelTransferAction, issueAction, resolveTransferAction, saveItemAction, saveParLevelAction,
  saveRecipeAction, stockInAction, recordWasteAction, cancelRequestAction,
} from './actions';

type Scope = { organizationSlug: string; branchSlug: string };
type Product = { id: string; name: string; category: string | null; variants: { id: string; name: string }[] };
type Can = { manage: boolean; stockIn: boolean; issue: boolean; waste: boolean; adjust: boolean };
type Tab = 'levels' | 'issue' | 'in' | 'recipes' | 'items' | 'waste';

const KINDS = ['warehouse', 'kitchen', 'bar'] as const;

export function StockManager({
  scope, branchId, currency, overview, products, can,
}: {
  scope: Scope; branchId: string; currency: string; overview: StockOverview; products: Product[]; can: Can;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(overview.items.length === 0 && can.manage ? 'items' : 'levels');

  // Live: alarms, requests and transfers re-render the page as they change.
  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const nudge = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), 400);
    };
    const channel = supabase.channel(`stock-${branchId}`);
    for (const table of ['inventory_alerts', 'inventory_requests', 'inventory_transfers']) {
      channel.on('postgres_changes' as never, { event: '*', schema: 'public', table, filter: `branch_id=eq.${branchId}` } as never, nudge);
    }
    channel.subscribe();
    return () => { if (timer) clearTimeout(timer); void supabase.removeChannel(channel); };
  }, [branchId, router]);

  const itemsById = useMemo(() => new Map(overview.items.map((i) => [i.id, i])), [overview.items]);
  const openRequests = overview.requests.length;
  const tabs: { key: Tab; label: string; icon: React.ComponentType<{ className?: string }>; badge?: number; show: boolean }[] = [
    { key: 'levels', label: 'الأرصدة والتنبيهات', icon: Boxes, badge: overview.alerts.length, show: true },
    { key: 'issue', label: 'الصرف والطلبات', icon: Truck, badge: openRequests, show: true },
    { key: 'in', label: 'إضافة مخزون', icon: PackagePlus, show: can.stockIn },
    { key: 'recipes', label: 'الوصفات', icon: Soup, show: true },
    { key: 'items', label: 'الخامات', icon: ClipboardList, show: true },
    { key: 'waste', label: 'الهالك والتسوية', icon: Trash2, show: can.waste || can.adjust },
  ];

  return (
    <div className="space-y-4">
      <nav className="flex flex-wrap gap-2" aria-label="أقسام المخزن">
        {tabs.filter((t) => t.show).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            aria-current={tab === t.key ? 'page' : undefined}
            className={`flex items-center gap-1.5 rounded border px-3 py-1.5 text-sm ${tab === t.key ? 'border-primary bg-primary-soft text-primary' : 'border-line bg-elevated text-muted hover:text-fg'}`}
            data-testid={`tab-${t.key}`}
          >
            <t.icon className="h-4 w-4" aria-hidden="true" />
            {t.label}
            {t.badge ? <span className="rounded-full bg-danger px-1.5 text-xs text-white lb-numeric">{t.badge}</span> : null}
          </button>
        ))}
      </nav>

      {tab === 'levels' && <LevelsTab scope={scope} overview={overview} itemsById={itemsById} canManage={can.manage} />}
      {tab === 'issue' && <IssueTab scope={scope} overview={overview} itemsById={itemsById} can={can} />}
      {tab === 'in' && <StockInTab scope={scope} items={overview.items} currency={currency} />}
      {tab === 'recipes' && <RecipesTab scope={scope} overview={overview} products={products} currency={currency} canManage={can.manage} />}
      {tab === 'items' && <ItemsTab scope={scope} items={overview.items} currency={currency} canManage={can.manage} />}
      {tab === 'waste' && <WasteTab scope={scope} overview={overview} itemsById={itemsById} can={can} currency={currency} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
function useRun() {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  async function run<T>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string; code: string }>, success: string, onApproval?: () => void) {
    const r = await fn();
    if (!r.ok) {
      if (r.code === 'approval_required' && onApproval) { onApproval(); return false; }
      toast.error(r.error);
      return false;
    }
    toast.success(success);
    router.refresh();
    return true;
  }
  return { pending, start, run, toast };
}

// ---------------------------------------------------------------------------
function LevelsTab({ scope, overview, itemsById, canManage }: {
  scope: Scope; overview: StockOverview; itemsById: Map<string, InventoryItem>; canManage: boolean;
}) {
  const { pending, start, run } = useRun();
  const [editing, setEditing] = useState<{ itemId: string; kind: (typeof KINDS)[number]; value: string } | null>(null);

  if (overview.items.length === 0) {
    return <Card><EmptyState icon={Boxes} title="لا توجد خامات بعد" description="أضف الخامات من تبويب «الخامات» ثم سجّل أول رصيد." /></Card>;
  }

  function saveMin() {
    if (!editing) return;
    const item = itemsById.get(editing.itemId);
    const raw = editing.value.trim();
    const minQty = raw === '' ? null : toBase(Number(raw), item!.unit, defaultInputUnit(item!.unit));
    start(async () => {
      const ok = await run(() => saveParLevelAction(scope, { kind: editing.kind, itemId: editing.itemId, minQty }), 'تم حفظ حد التنبيه');
      if (ok) setEditing(null);
    });
  }

  return (
    <div className="space-y-4">
      {overview.alerts.length > 0 && (
        <Card className="border-danger/40">
          <CardHeader><CardTitle className="flex items-center gap-2 text-danger"><AlertTriangle className="h-5 w-5" aria-hidden="true" /> تنبيهات نقص المخزون</CardTitle></CardHeader>
          <CardBody>
            <ul className="divide-y divide-line" data-testid="stock-alerts">
              {overview.alerts.map((a) => {
                const item = itemsById.get(a.itemId);
                return (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <span className="font-semibold">{item?.name ?? '—'} · {LOCATION_LABELS[a.location]}</span>
                    <span className="flex items-center gap-2">
                      <Badge tone={a.kind === 'out' ? 'danger' : 'warn'}>{a.kind === 'out' ? 'نفد' : 'منخفض'}</Badge>
                      <span className="lb-numeric text-muted">{item ? formatQty(a.qty, item.unit) : a.qty} / الحد {item ? formatQty(a.minQty, item.unit) : a.minQty}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </CardBody>
        </Card>
      )}

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="stock-levels">
            <caption className="sr-only">أرصدة الخامات حسب المكان</caption>
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                <th scope="col" className="p-3 text-start font-medium">الخامة</th>
                {KINDS.map((k) => <th key={k} scope="col" className="p-3 text-start font-medium">{LOCATION_LABELS[k]}</th>)}
                <th scope="col" className="p-3 text-start font-medium">{LOCATION_LABELS.transit}</th>
              </tr>
            </thead>
            <tbody>
              {overview.items.filter((i) => i.isActive).map((item) => (
                <tr key={item.id} className="border-b border-line last:border-0">
                  <td className="p-3 font-medium">{item.name}<span className="ms-1 text-xs text-muted">({BASE_UNIT_LABELS[item.unit]})</span></td>
                  {KINDS.map((k) => {
                    const qty = overview.levels[k]?.[item.id] ?? 0;
                    const min = overview.minLevels[k]?.[item.id];
                    const low = min !== undefined && qty <= min;
                    const isEditing = editing?.itemId === item.id && editing.kind === k;
                    return (
                      <td key={k} className="p-3 align-top">
                        <div className={`lb-numeric font-semibold ${qty < 0 ? 'text-danger' : low ? 'text-warn' : ''}`}>{formatQty(qty, item.unit)}</div>
                        {isEditing ? (
                          <div className="mt-1 flex items-center gap-1">
                            <Input
                              aria-label="حد التنبيه"
                              className="h-8 w-20"
                              dir="ltr"
                              inputMode="decimal"
                              autoFocus
                              value={editing.value}
                              onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                              onKeyDown={(e) => { if (e.key === 'Enter') saveMin(); if (e.key === 'Escape') setEditing(null); }}
                            />
                            <span className="text-xs text-muted">{INPUT_UNITS[item.unit][0]!.label}</span>
                            <Button size="sm" disabled={pending} onClick={saveMin}>حفظ</Button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            disabled={!canManage}
                            onClick={() => setEditing({ itemId: item.id, kind: k, value: min === undefined ? '' : String(min / INPUT_UNITS[item.unit][0]!.factor) })}
                            className="text-xs text-muted underline decoration-dotted disabled:no-underline"
                          >
                            {min === undefined ? (canManage ? 'ضبط حد التنبيه' : 'بدون حد') : `الحد: ${formatQty(min, item.unit)}`}
                          </button>
                        )}
                      </td>
                    );
                  })}
                  <td className="p-3 align-top lb-numeric text-muted">{formatQty(overview.levels.transit?.[item.id] ?? 0, item.unit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
function IssueTab({ scope, overview, itemsById, can }: {
  scope: Scope; overview: StockOverview; itemsById: Map<string, InventoryItem>; can: Can;
}) {
  const { pending, start, run, toast } = useRun();
  const approval = useApproval(scope);
  const [to, setTo] = useState<'kitchen' | 'bar'>('kitchen');
  const [lines, setLines] = useState<DraftLine[]>([newLine()]);
  const [note, setNote] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);

  function fillFromRequest(r: StockOverview['requests'][number]) {
    setTo(r.location === 'bar' ? 'bar' : 'kitchen');
    setRequestId(r.id);
    setLines(r.lines.map((l) => {
      const item = itemsById.get(l.itemId);
      const unit = defaultInputUnit(item?.unit);
      const factor = item ? INPUT_UNITS[item.unit][0]!.factor : 1;
      return newLine(l.itemId, unit, String(l.qty / factor));
    }));
    setNote(r.note ?? '');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function submit() {
    const base = toBaseLines(lines, overview.items);
    if (!base || base.length === 0) { toast.error('راجع الخامات والكميات'); return; }
    start(async () => {
      const ok = await run(() => issueAction(scope, { to, lines: base.map(({ itemId, qty }) => ({ itemId, qty })), requestId, note: note || undefined }),
        `تم الصرف إلى ${LOCATION_LABELS[to]} — بانتظار تأكيد الاستلام`);
      if (ok) { setLines([newLine()]); setNote(''); setRequestId(null); }
    });
  }

  function resolve(transferId: string, outcome: 'found' | 'lost') {
    const go = async () => {
      await run(() => resolveTransferAction(scope, { transferId, outcome }), 'تمت تسوية الفرق',
        () => approval.request('inventory.resolve', transferId, null, go));
    };
    start(go);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
      <div className="space-y-4">
        {can.issue && (
          <Card>
            <CardHeader><CardTitle>صرف من المخزن</CardTitle></CardHeader>
            <CardBody className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted">إلى</span>
                {(['kitchen', 'bar'] as const).map((k) => (
                  <button key={k} type="button" onClick={() => setTo(k)}
                    className={`rounded border px-3 py-1.5 text-sm ${to === k ? 'border-primary bg-primary-soft text-primary' : 'border-line'}`}>
                    {LOCATION_LABELS[k]}
                  </button>
                ))}
                {requestId ? <Badge tone="info">من طلب صرف</Badge> : null}
              </div>
              <LinesEditor items={overview.items.filter((i) => i.isActive)} lines={lines} onChange={setLines} testId="issue-lines" />
              <Input placeholder="ملاحظة (اختياري)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
              <p className="text-xs text-muted">لا تصبح الكمية في عهدة {LOCATION_LABELS[to]} إلا بعد تأكيد الاستلام من هناك — وبواسطة شخص غيرك.</p>
              <Button onClick={submit} disabled={pending} data-testid="issue-submit">صرف</Button>
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader><CardTitle>التحويلات الأخيرة</CardTitle></CardHeader>
          <CardBody>
            {overview.transfers.length === 0 ? <p className="text-sm text-muted">لا توجد تحويلات بعد.</p> : (
              <ul className="divide-y divide-line" data-testid="transfers">
                {overview.transfers.map((t) => (
                  <li key={t.id} className="space-y-1 py-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold"><bdi>{t.number}</bdi> · إلى {LOCATION_LABELS[t.to]}</span>
                      <Badge tone={t.status === 'disputed' ? 'danger' : t.status === 'issued' ? 'warn' : t.status === 'cancelled' ? 'neutral' : 'success'}>
                        {TRANSFER_STATUS_LABELS[t.status] ?? t.status}
                      </Badge>
                    </div>
                    <ul className="text-xs text-muted">
                      {t.lines.map((l) => {
                        const item = itemsById.get(l.itemId);
                        const short = l.receivedQty !== null && l.issuedQty !== null && l.receivedQty < l.issuedQty;
                        return (
                          <li key={l.id} className={short ? 'text-danger' : ''}>
                            {item?.name}: صُرف {item && l.issuedQty !== null ? formatQty(l.issuedQty, item.unit) : '—'}
                            {l.receivedQty !== null && item ? ` · استُلم ${formatQty(l.receivedQty, item.unit)}` : ''}
                          </li>
                        );
                      })}
                    </ul>
                    <div className="flex flex-wrap gap-2">
                      {t.status === 'issued' && can.issue && (
                        <Button size="sm" variant="ghost" disabled={pending}
                          onClick={() => start(async () => { await run(() => cancelTransferAction(scope, { transferId: t.id }), 'تم إلغاء الصرف وإرجاع الكمية للمخزن'); })}>
                          إلغاء الصرف
                        </Button>
                      )}
                      {t.status === 'disputed' && can.adjust && (
                        <>
                          <Button size="sm" variant="outline" disabled={pending} onClick={() => resolve(t.id, 'found')}>وُجد الفرق — أضفه للعهدة</Button>
                          <Button size="sm" variant="ghost" className="text-danger" disabled={pending} onClick={() => resolve(t.id, 'lost')}>فقد — سجّله هالك</Button>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <Card className="h-fit">
        <CardHeader><CardTitle>طلبات الصرف المفتوحة</CardTitle></CardHeader>
        <CardBody>
          {overview.requests.length === 0 ? <p className="text-sm text-muted">لا توجد طلبات من المطبخ أو البار.</p> : (
            <ul className="space-y-3" data-testid="requests">
              {overview.requests.map((r) => (
                <li key={r.id} className="rounded border border-line p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{LOCATION_LABELS[r.location]}</span>
                    <span className="text-xs text-muted lb-numeric">{new Date(r.createdAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  <ul className="mt-1 text-xs text-muted">
                    {r.lines.map((l) => {
                      const item = itemsById.get(l.itemId);
                      return <li key={l.itemId}>{item?.name}: {item ? formatQty(l.qty, item.unit) : l.qty}</li>;
                    })}
                  </ul>
                  {r.note ? <p className="mt-1 text-xs">{r.note}</p> : null}
                  <div className="mt-2 flex gap-2">
                    {can.issue && <Button size="sm" onClick={() => fillFromRequest(r)}>صرف هذا الطلب</Button>}
                    <Button size="sm" variant="ghost" disabled={pending}
                      onClick={() => start(async () => { await run(() => cancelRequestAction(scope, { requestId: r.id }), 'تم إلغاء الطلب'); })}>
                      رفض
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
      {approval.dialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
function StockInTab({ scope, items, currency }: { scope: Scope; items: InventoryItem[]; currency: string }) {
  const { pending, start, run, toast } = useRun();
  const [lines, setLines] = useState<DraftLine[]>([newLine()]);
  const [note, setNote] = useState('');

  function submit() {
    const base = toBaseLines(lines, items);
    if (!base || base.length === 0) { toast.error('راجع الخامات والكميات'); return; }
    const payload = base.map((l, idx) => {
      const draft = lines.filter((x) => x.itemId || x.amount)[idx]!;
      const item = items.find((i) => i.id === l.itemId)!;
      const price = Number((l.extra ?? '').replace(',', '.'));
      const unit = (INPUT_UNITS[item.unit].some((u) => u.key === draft.inputUnit) ? draft.inputUnit : defaultInputUnit(item.unit)) as InputUnit;
      return {
        itemId: l.itemId, qty: l.qty,
        unitCostCents: l.extra && Number.isFinite(price) && price >= 0 ? costToBase(Math.round(price * 100), item.unit, unit) : undefined,
      };
    });
    start(async () => {
      const ok = await run(() => stockInAction(scope, { lines: payload, note: note || undefined }), 'تمت إضافة الكمية إلى المخزن');
      if (ok) { setLines([newLine()]); setNote(''); }
    });
  }

  return (
    <Card className="max-w-3xl">
      <CardHeader><CardTitle>استلام بضاعة في المخزن</CardTitle></CardHeader>
      <CardBody className="space-y-3">
        <LinesEditor
          items={items.filter((i) => i.isActive)}
          lines={lines}
          onChange={setLines}
          extraColumn={{ placeholder: (u) => `سعر ال${u} (${currency})` }}
          testId="stockin-lines"
        />
        <Input placeholder="رقم فاتورة المورد / ملاحظة" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
        <p className="text-xs text-muted">السعر اختياري؛ عند إدخاله يُحدَّث متوسط تكلفة الخامة تلقائيًا.</p>
        <Button onClick={submit} disabled={pending} data-testid="stockin-submit">إضافة للمخزن</Button>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
function RecipesTab({ scope, overview, products, currency, canManage }: {
  scope: Scope; overview: StockOverview; products: Product[]; currency: string; canManage: boolean;
}) {
  const { pending, start, run, toast } = useRun();
  const [productId, setProductId] = useState(products[0]?.id ?? '');
  const product = products.find((p) => p.id === productId);
  const [variantId, setVariantId] = useState(product?.variants[0]?.id ?? '');
  const items = overview.items;

  const load = (vid: string): DraftLine[] => {
    const rows = overview.recipes[vid] ?? [];
    if (rows.length === 0) return [newLine()];
    return rows.map((r) => {
      const item = items.find((i) => i.id === r.itemId);
      const unit: InputUnit = item?.unit === 'pc' ? 'pc' : item?.unit === 'ml' ? 'ml' : 'g';
      const l = newLine(r.itemId, unit, String(r.qty));
      l.extra = r.locationKind ?? '';
      return l;
    });
  };
  const [lines, setLines] = useState<DraftLine[]>(() => load(variantId));

  useEffect(() => { setLines(load(variantId)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [variantId, overview.recipes]);

  if (products.length === 0) {
    return <Card><EmptyState icon={Soup} title="لا توجد أصناف في المنيو" description="أضف أصناف المنيو أولًا، ثم اربط كل صنف بمكوناته هنا." /></Card>;
  }

  const base = toBaseLines(lines, items);
  const portionCost = (base ?? []).reduce((sum, l) => sum + l.qty * (items.find((i) => i.id === l.itemId)?.avgCostCents ?? 0), 0);

  function save() {
    if (!base) { toast.error('راجع المكونات والكميات'); return; }
    start(async () => {
      await run(() => saveRecipeAction(scope, {
        variantId,
        lines: base.map((l) => ({ itemId: l.itemId, qty: l.qty, locationKind: l.extra === 'kitchen' || l.extra === 'bar' ? l.extra : null })),
      }), 'تم حفظ الوصفة');
    });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
      <Card className="h-fit">
        <CardHeader><CardTitle>الصنف</CardTitle></CardHeader>
        <CardBody className="space-y-3">
          <Field label="الصنف من المنيو">
            {(p) => (
              <Select {...p} value={productId} onChange={(e) => {
                setProductId(e.target.value);
                const first = products.find((x) => x.id === e.target.value)?.variants[0]?.id ?? '';
                setVariantId(first);
              }} data-testid="recipe-product">
                {products.map((x) => <option key={x.id} value={x.id}>{x.name}{x.category ? ` — ${x.category}` : ''}</option>)}
              </Select>
            )}
          </Field>
          {product && product.variants.length > 1 && (
            <Field label="الحجم">
              {(p) => (
                <Select {...p} value={variantId} onChange={(e) => setVariantId(e.target.value)}>
                  {product.variants.map((v) => <option key={v.id} value={v.id}>{v.name === 'default' ? 'عادي' : v.name}</option>)}
                </Select>
              )}
            </Field>
          )}
          <p className="text-xs text-muted">
            تُخصم هذه الكميات تلقائيًا من مخزون المطبخ أو البار لحظة تأكيد كل طلب، لكل وحدة مطلوبة.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>مكونات الحصة الواحدة</CardTitle></CardHeader>
        <CardBody className="space-y-3">
          {items.length === 0 ? <p className="text-sm text-muted">أضف الخامات أولًا من تبويب «الخامات».</p> : (
            <>
              <RecipeLines items={items.filter((i) => i.isActive)} lines={lines} onChange={setLines} />
              <p className="text-sm">
                تكلفة الحصة التقديرية: <strong className="lb-numeric">{formatMoney(Math.round(portionCost), currency)}</strong>
              </p>
              {canManage ? <Button onClick={save} disabled={pending} data-testid="recipe-save">حفظ الوصفة</Button>
                         : <p className="text-xs text-muted">تعديل الوصفات للمدير أو أمين المخزن.</p>}
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/** Recipe rows: the same editor, with the unit limited to the item's base, and an optional source station. */
function RecipeLines({ items, lines, onChange }: { items: InventoryItem[]; lines: DraftLine[]; onChange: (l: DraftLine[]) => void }) {
  return (
    <div className="space-y-2">
      <LinesEditor items={items} lines={lines} onChange={onChange} testId="recipe-lines" />
      <details className="text-xs text-muted">
        <summary className="cursor-pointer">مكوّن يُصرف من مكان آخر؟</summary>
        <p className="mt-1">افتراضيًا يُخصم كل مكوّن من محطة الصنف نفسه (المطبخ للأكل، البار للمشروبات). لتغيير ذلك لمكوّن معيّن اختر المكان:</p>
        <ul className="mt-2 space-y-1">
          {lines.filter((l) => l.itemId).map((l) => (
            <li key={l.key} className="flex items-center gap-2">
              <span className="min-w-24">{items.find((i) => i.id === l.itemId)?.name}</span>
              <Select className="h-8 w-36" value={l.extra ?? ''} onChange={(e) => onChange(lines.map((x) => (x.key === l.key ? { ...x, extra: e.target.value } : x)))}>
                <option value="">محطة الصنف</option>
                <option value="kitchen">المطبخ</option>
                <option value="bar">البار</option>
              </Select>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------
function ItemsTab({ scope, items, currency, canManage }: { scope: Scope; items: InventoryItem[]; currency: string; canManage: boolean }) {
  const { pending, start, run } = useRun();
  const [name, setName] = useState('');
  const [unit, setUnit] = useState<BaseUnit>('g');

  function add() {
    if (!name.trim()) return;
    start(async () => {
      const ok = await run(() => saveItemAction(scope, { id: null, name: name.trim(), unit, isActive: true }), 'تمت إضافة الخامة');
      if (ok) setName('');
    });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
      {canManage && (
        <Card className="h-fit">
          <CardHeader><CardTitle>خامة جديدة</CardTitle></CardHeader>
          <CardBody className="space-y-3">
            <Field label="الاسم">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="مثال: طماطم" maxLength={120} data-testid="item-name" />}</Field>
            <Field label="تُحسب بـ" hint="الجرام والمللي يُدخلان أيضًا بالكيلو واللتر">
              {(p) => (
                <Select {...p} value={unit} onChange={(e) => setUnit(e.target.value as BaseUnit)} data-testid="item-unit">
                  <option value="g">الوزن (جرام / كيلو)</option>
                  <option value="ml">الحجم (مللي / لتر)</option>
                  <option value="pc">العدد (قطعة)</option>
                </Select>
              )}
            </Field>
            <Button onClick={add} disabled={pending || !name.trim()} data-testid="item-add">إضافة</Button>
          </CardBody>
        </Card>
      )}
      <Card>
        <CardHeader><CardTitle>الخامات ({items.length})</CardTitle></CardHeader>
        <CardBody>
          {items.length === 0 ? <p className="text-sm text-muted">لا توجد خامات بعد.</p> : (
            <ul className="divide-y divide-line text-sm">
              {items.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className={i.isActive ? '' : 'text-muted line-through'}>{i.name} <span className="text-xs text-muted">({BASE_UNIT_LABELS[i.unit]})</span></span>
                  <span className="flex items-center gap-3 text-xs text-muted">
                    <span className="lb-numeric">متوسط التكلفة: {formatMoney(Math.round(costPerPurchaseUnit(i.avgCostCents, i.unit)), currency)} / {INPUT_UNITS[i.unit][0]!.label}</span>
                    {canManage && (
                      <button type="button" className="underline decoration-dotted" disabled={pending}
                        onClick={() => start(async () => { await run(() => saveItemAction(scope, { id: i.id, name: i.name, unit: i.unit, isActive: !i.isActive }), i.isActive ? 'تم إيقاف الخامة' : 'تم تفعيل الخامة'); })}>
                        {i.isActive ? 'إيقاف' : 'تفعيل'}
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
function WasteTab({ scope, overview, itemsById, can, currency }: {
  scope: Scope; overview: StockOverview; itemsById: Map<string, InventoryItem>; can: Can; currency: string;
}) {
  const { pending, start, run, toast } = useRun();
  const approval = useApproval(scope);
  const items = overview.items.filter((i) => i.isActive);
  const [w, setW] = useState({ kind: 'warehouse' as (typeof KINDS)[number], itemId: '', amount: '', reason: 'spoiled', note: '' });
  const [a, setA] = useState({ kind: 'warehouse' as (typeof KINDS)[number], itemId: '', amount: '', direction: 'add' as 'add' | 'remove', note: '' });

  function qtyOf(itemId: string, amount: string) {
    const item = itemsById.get(itemId);
    const n = Number(amount.replace(',', '.'));
    if (!item || !Number.isFinite(n) || n <= 0) return null;
    return toBase(n, item.unit, defaultInputUnit(item.unit));
  }

  function recordWaste() {
    const qty = qtyOf(w.itemId, w.amount);
    if (qty === null) { toast.error('اختر الخامة والكمية'); return; }
    start(async () => {
      const ok = await run(() => recordWasteAction(scope, { kind: w.kind, itemId: w.itemId, qty, reason: w.reason as never, note: w.note || undefined }), 'تم تسجيل الهالك');
      if (ok) setW({ ...w, amount: '', note: '' });
    });
  }

  function doAdjust() {
    const qty = qtyOf(a.itemId, a.amount);
    if (qty === null || !a.note.trim()) { toast.error('اختر الخامة والكمية واكتب السبب'); return; }
    const delta = a.direction === 'add' ? qty : -qty;
    const go = async () => {
      const ok = await run(() => adjustAction(scope, { kind: a.kind, itemId: a.itemId, delta, note: a.note.trim() }), 'تمت التسوية',
        () => approval.request('inventory.adjust', a.itemId, Math.abs(delta), go));
      if (ok) setA({ ...a, amount: '', note: '' });
    };
    start(go);
  }

  const unitLabel = (itemId: string) => { const i = itemsById.get(itemId); return i ? INPUT_UNITS[i.unit][0]!.label : ''; };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {can.waste && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Trash2 className="h-5 w-5" aria-hidden="true" /> تسجيل هالك</CardTitle></CardHeader>
          <CardBody className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <Select aria-label="المكان" value={w.kind} onChange={(e) => setW({ ...w, kind: e.target.value as never })}>
                {KINDS.map((k) => <option key={k} value={k}>{LOCATION_LABELS[k]}</option>)}
              </Select>
              <Select aria-label="الخامة" value={w.itemId} onChange={(e) => setW({ ...w, itemId: e.target.value })} data-testid="waste-item">
                <option value="">اختر الخامة…</option>
                {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </Select>
              <div className="flex items-center gap-2">
                <Input aria-label="الكمية" dir="ltr" inputMode="decimal" value={w.amount} onChange={(e) => setW({ ...w, amount: e.target.value })} />
                <span className="text-sm text-muted">{unitLabel(w.itemId)}</span>
              </div>
              <Select aria-label="السبب" value={w.reason} onChange={(e) => setW({ ...w, reason: e.target.value })}>
                {WASTE_REASONS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
              </Select>
            </div>
            <Input placeholder={w.reason === 'other' ? 'اكتب السبب (مطلوب)' : 'ملاحظة (اختياري)'} value={w.note} onChange={(e) => setW({ ...w, note: e.target.value })} maxLength={300} />
            <Button onClick={recordWaste} disabled={pending}>تسجيل</Button>
          </CardBody>
        </Card>
      )}

      {can.adjust && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Scale className="h-5 w-5" aria-hidden="true" /> تسوية يدوية (بموافقة المدير)</CardTitle></CardHeader>
          <CardBody className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <Select aria-label="المكان" value={a.kind} onChange={(e) => setA({ ...a, kind: e.target.value as never })}>
                {KINDS.map((k) => <option key={k} value={k}>{LOCATION_LABELS[k]}</option>)}
              </Select>
              <Select aria-label="الخامة" value={a.itemId} onChange={(e) => setA({ ...a, itemId: e.target.value })}>
                <option value="">اختر الخامة…</option>
                {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </Select>
              <Select aria-label="النوع" value={a.direction} onChange={(e) => setA({ ...a, direction: e.target.value as never })}>
                <option value="add">زيادة (+)</option>
                <option value="remove">نقص (−)</option>
              </Select>
              <div className="flex items-center gap-2">
                <Input aria-label="الكمية" dir="ltr" inputMode="decimal" value={a.amount} onChange={(e) => setA({ ...a, amount: e.target.value })} />
                <span className="text-sm text-muted">{unitLabel(a.itemId)}</span>
              </div>
            </div>
            <Input placeholder="السبب (مطلوب) — مثال: فرق جرد" value={a.note} onChange={(e) => setA({ ...a, note: e.target.value })} maxLength={300} />
            <Button onClick={doAdjust} disabled={pending} data-testid="adjust-submit">تسوية</Button>
          </CardBody>
        </Card>
      )}

      <Card className="lg:col-span-2">
        <CardHeader><CardTitle>آخر الهالك</CardTitle></CardHeader>
        <CardBody>
          {overview.waste.length === 0 ? <p className="text-sm text-muted">لا يوجد هالك مسجّل.</p> : (
            <ul className="divide-y divide-line text-sm">
              {overview.waste.map((x) => {
                const item = itemsById.get(x.itemId);
                return (
                  <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>{item?.name} · {LOCATION_LABELS[x.location]} · {WASTE_REASON_LABELS[x.reason] ?? x.reason}{x.note ? ` — ${x.note}` : ''}</span>
                    <span className="lb-numeric text-muted">{item ? formatQty(x.qty, item.unit) : x.qty} · {formatMoney(Math.round(x.costCents), currency)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>
      {approval.dialog}
    </div>
  );
}
