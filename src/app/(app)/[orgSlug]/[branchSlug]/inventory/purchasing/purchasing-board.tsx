'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, PackageCheck, Plus, Send, ShoppingCart, Truck, X } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input, Select } from '@/components/ui/field';
import { ConfirmDialog } from '@/components/ui/confirm';
import { useToast } from '@/components/ui/toast';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/cn';
import { suggestedReorder } from '@/modules/restaurant/costing/calc';
import type { PurchaseOrder, PurchasingItem, Suggestion, Supplier, Threshold } from '@/modules/restaurant/purchasing/service';
import { formatQty, type BaseUnit } from '@/modules/restaurant/inventory/units';
import {
  generateOrdersAction, receivePoAction, savePoAction, saveSupplierAction, saveThresholdAction, setItemSupplierAction, setPoStatusAction,
} from './actions';

type Scope = { organizationSlug: string; branchSlug: string };
type Can = { purchase: boolean; receive: boolean; manage: boolean };

/** People buy in kg / L / pieces; the database counts g / ml / pieces. */
const factor = (u: BaseUnit) => (u === 'pc' ? 1 : 1000);
const buyUnit = (u: BaseUnit) => (u === 'g' ? 'كجم' : u === 'ml' ? 'لتر' : 'قطعة');
const toInput = (baseQty: number, u: BaseUnit) => String(Math.round((baseQty / factor(u)) * 1000) / 1000);
const fromInput = (text: string, u: BaseUnit) => Math.round(Number(text) * factor(u) * 1000) / 1000;

const STATUS = {
  draft: { label: 'مسودة', tone: 'neutral' }, sent: { label: 'أُرسل للمورد', tone: 'info' },
  received: { label: 'تم الاستلام', tone: 'success' }, cancelled: { label: 'ملغي', tone: 'danger' },
} as const;

export function PurchasingBoard({ scope, currency, suggestions, orders, suppliers, thresholds, items, can }: {
  scope: Scope; currency: string; suggestions: Suggestion[]; orders: PurchaseOrder[]; suppliers: Supplier[];
  thresholds: Threshold[]; items: PurchasingItem[]; can: Can;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const money = (c: number) => formatMoney(Math.round(c), currency);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const supplierName = (id: string | null) => (id ? suppliers.find((s) => s.id === id)?.name ?? '—' : 'بدون مورد محدد');
  const [tab, setTab] = useState<'alerts' | 'orders' | 'levels' | 'suppliers'>(suggestions.length ? 'alerts' : 'orders');
  const open = orders.filter((o) => o.status === 'draft' || o.status === 'sent');
  const estimate = suggestions.reduce((s, x) => s + x.suggestedQty * x.unitCostCents, 0);

  function generate() {
    start(async () => {
      const r = await generateOrdersAction(scope, {});
      if (!r.ok) { toast.error(r.error); return; }
      toast.success(r.data.count ? `أُنشئ ${r.data.count} طلب شراء (${r.data.orders.map((o) => o.number).join('، ')})` : 'لا توجد خامات تحتاج طلب شراء');
      setTab('orders');
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card><CardBody className="flex items-start justify-between">
          <div><p className="text-xs text-muted">خامات تحت الحد الأدنى</p><p className="lb-numeric text-2xl font-bold">{suggestions.length}</p></div>
          {suggestions.length > 0 && <AlertTriangle className="h-5 w-5 text-warn" aria-label="تنبيه" />}
        </CardBody></Card>
        <Card><CardBody><p className="text-xs text-muted">طلبات مفتوحة</p><p className="lb-numeric text-2xl font-bold">{open.length}</p></CardBody></Card>
        <Card><CardBody><p className="text-xs text-muted">تكلفة الشراء المقترح (تقديرية)</p><p className="lb-numeric text-2xl font-bold">{money(estimate)}</p></CardBody></Card>
      </div>

      <div className="flex flex-wrap gap-1" role="tablist">
        {([['alerts', `تنبيهات المخزون (${suggestions.length})`], ['orders', `طلبات الشراء (${open.length})`], ['levels', 'الحدود ونقاط إعادة الطلب'], ['suppliers', 'الموردون']] as const).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={cn('rounded border px-3 py-1.5 text-sm', tab === k ? 'border-primary bg-primary-soft text-primary' : 'border-line')}>{l}</button>
        ))}
      </div>

      {tab === 'alerts' && (
        <Card>
          <CardHeader className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>خامات وصلت للحد الأدنى في المخزن</CardTitle>
            {can.purchase && (
              <Button onClick={generate} disabled={pending || suggestions.length === 0} data-testid="generate-pos">
                <ShoppingCart className="h-4 w-4" aria-hidden="true" /> إنشاء طلبات الشراء
              </Button>
            )}
          </CardHeader>
          <CardBody className="p-0">
            {suggestions.length === 0 ? (
              <p className="p-5 text-center text-sm text-muted">كل الخامات فوق حدها الأدنى، أو مغطاة بطلبات شراء مفتوحة.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="suggestions">
                  <thead className="border-b border-line text-xs text-muted">
                    <tr><th className="p-2 text-start">الخامة</th><th className="p-2 text-end">الرصيد</th><th className="p-2 text-end">الحد الأدنى</th><th className="p-2 text-end">في الطريق</th><th className="p-2 text-end">المقترح</th><th className="p-2 text-start">المورد</th><th className="p-2 text-end">التكلفة</th></tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {suggestions.map((s) => (
                      <tr key={s.itemId}>
                        <td className="p-2 font-medium">{s.name}{s.onHand <= 0 && <Badge tone="danger" className="ms-1">نفد</Badge>}</td>
                        <td className={cn('lb-numeric p-2 text-end', s.onHand <= 0 && 'text-danger')}>{formatQty(s.onHand, s.unit)}</td>
                        <td className="lb-numeric p-2 text-end">{formatQty(s.minQty, s.unit)}</td>
                        <td className="lb-numeric p-2 text-end">{s.openPoQty ? formatQty(s.openPoQty, s.unit) : '—'}</td>
                        <td className="lb-numeric p-2 text-end font-bold">{formatQty(s.suggestedQty, s.unit)}</td>
                        <td className="p-2 text-xs">{supplierName(s.supplierId)}</td>
                        <td className="lb-numeric p-2 text-end">{money(s.suggestedQty * s.unitCostCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {tab === 'orders' && (
        <div className="space-y-3">
          {can.purchase && <NewOrder scope={scope} items={items} suppliers={suppliers} />}
          {orders.length === 0 ? <p className="text-sm text-muted">لا طلبات شراء بعد.</p> : orders.map((o) => (
            <OrderCard key={o.id} scope={scope} order={o} itemById={itemById} supplierName={supplierName(o.supplierId)} money={money} can={can} />
          ))}
        </div>
      )}

      {tab === 'levels' && <LevelsPanel scope={scope} items={items} thresholds={thresholds} suppliers={suppliers} can={can} />}
      {tab === 'suppliers' && <SuppliersPanel scope={scope} suppliers={suppliers} canEdit={can.purchase} />}
    </div>
  );
}

function OrderCard({ scope, order, itemById, supplierName, money, can }: {
  scope: Scope; order: PurchaseOrder; itemById: Map<string, PurchasingItem>; supplierName: string; money: (c: number) => string; can: Can;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [costs, setCosts] = useState<Record<string, string>>({});
  const s = STATUS[order.status];

  function reset(mode: 'edit' | 'receive') {
    setQtys(Object.fromEntries(order.lines.map((l) => [l.itemId, toInput(l.qtyOrdered, itemById.get(l.itemId)?.unit ?? 'g')])));
    setCosts(Object.fromEntries(order.lines.map((l) => {
      const u = itemById.get(l.itemId)?.unit ?? 'g';
      return [l.itemId, String(Math.round(l.unitCostCents * factor(u)) / 100)];
    })));
    if (mode === 'edit') setEditing(true); else setReceiving(true);
  }
  const linePayload = () => order.lines.map((l) => {
    const u = itemById.get(l.itemId)?.unit ?? 'g';
    return { itemId: l.itemId, qty: fromInput(qtys[l.itemId] ?? '0', u), unitCostCents: (Number(costs[l.itemId] ?? 0) * 100) / factor(u) };
  });

  function status(next: 'sent' | 'cancelled') {
    start(async () => {
      const r = await setPoStatusAction(scope, { id: order.id, status: next });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success(next === 'sent' ? 'أُرسل الطلب' : 'أُلغي الطلب'); router.refresh();
    });
  }
  function saveEdit() {
    const lines = linePayload().filter((l) => l.qty > 0);
    if (!lines.length) { toast.error('الطلب يحتاج خامة واحدة على الأقل'); return; }
    start(async () => {
      const r = await savePoAction(scope, { id: order.id, supplierId: order.supplierId, note: order.note ?? undefined, expectedOn: order.expectedOn, lines });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success('تم حفظ الطلب'); setEditing(false); router.refresh();
    });
  }
  function receive() {
    start(async () => {
      const r = await receivePoAction(scope, { id: order.id, lines: linePayload() });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success(`تم الاستلام: ${r.data.lines} خامة بقيمة ${money(r.data.totalCents)}`); setReceiving(false); router.refresh();
    });
  }

  return (
    <Card data-testid={`po-${order.number}`}>
      <CardBody className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="font-bold">{order.number} <Badge tone={s.tone}>{s.label}</Badge> {order.autoGenerated && <Badge tone="neutral">تلقائي</Badge>}</p>
            <p className="flex items-center gap-1 text-xs text-muted"><Truck className="h-3.5 w-3.5" aria-hidden="true" /> {supplierName} · {new Date(order.createdAt).toLocaleDateString('ar-EG')}</p>
          </div>
          <p className="lb-numeric font-bold">{money(order.totalCents)}</p>
        </div>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-line">
            {order.lines.map((l) => {
              const it = itemById.get(l.itemId); const u = it?.unit ?? 'g';
              return (
                <tr key={l.itemId}>
                  <td className="py-1">{it?.name ?? '—'}</td>
                  <td className="lb-numeric py-1 text-end">
                    {editing ? (
                      <span className="inline-flex items-center gap-1"><Input aria-label={`كمية ${it?.name}`} dir="ltr" inputMode="decimal" className="h-8 w-24" value={qtys[l.itemId] ?? ''} onChange={(e) => setQtys({ ...qtys, [l.itemId]: e.target.value })} /> {buyUnit(u)}</span>
                    ) : (
                      <>{formatQty(l.qtyOrdered, u)}{l.qtyReceived !== null && <span className="text-xs text-muted"> · استُلم {formatQty(l.qtyReceived, u)}</span>}</>
                    )}
                  </td>
                  <td className="lb-numeric py-1 text-end text-xs text-muted">{money((l.receivedUnitCostCents ?? l.unitCostCents) * factor(u))} / {buyUnit(u)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {(order.status === 'draft' || order.status === 'sent') && can.purchase && (
          <div className="flex flex-wrap gap-1">
            {order.status === 'draft' && !editing && <Button size="sm" variant="secondary" onClick={() => reset('edit')}>تعديل</Button>}
            {editing && <><Button size="sm" disabled={pending} onClick={saveEdit}>حفظ</Button><Button size="sm" variant="ghost" onClick={() => setEditing(false)}>إلغاء</Button></>}
            {order.status === 'draft' && !editing && <Button size="sm" disabled={pending} onClick={() => status('sent')} data-testid="po-send"><Send className="h-4 w-4" aria-hidden="true" /> إرسال للمورد</Button>}
            {can.receive && !editing && <Button size="sm" variant="secondary" disabled={pending} onClick={() => reset('receive')} data-testid="po-receive"><PackageCheck className="h-4 w-4" aria-hidden="true" /> استلام</Button>}
            {!editing && <Button size="sm" variant="ghost" className="text-danger" disabled={pending} onClick={() => status('cancelled')}><X className="h-4 w-4" aria-hidden="true" /> إلغاء الطلب</Button>}
          </div>
        )}
      </CardBody>
      <ConfirmDialog open={receiving} tone="primary" busy={pending} title={`استلام ${order.number}`} confirmLabel="تأكيد الاستلام"
        description="اكتب ما وصل فعلًا وسعره من فاتورة المورد. الناقص يُسجَّل كما هو ويُغلق الطلب؛ الكميات تدخل المخزن ويتحدث متوسط التكلفة."
        onCancel={() => setReceiving(false)} onConfirm={receive}>
        <div className="space-y-2">
          {order.lines.map((l) => {
            const it = itemById.get(l.itemId); const u = it?.unit ?? 'g';
            return (
              <div key={l.itemId} className="grid grid-cols-[1fr_6rem_6rem] items-center gap-2 text-sm">
                <span>{it?.name}</span>
                <Input aria-label={`الكمية المستلمة ${it?.name}`} dir="ltr" inputMode="decimal" value={qtys[l.itemId] ?? ''} onChange={(e) => setQtys({ ...qtys, [l.itemId]: e.target.value })} />
                <Input aria-label={`السعر لكل ${buyUnit(u)}`} dir="ltr" inputMode="decimal" value={costs[l.itemId] ?? ''} onChange={(e) => setCosts({ ...costs, [l.itemId]: e.target.value })} />
              </div>
            );
          })}
          <p className="text-xs text-muted">الكمية بوحدة الشراء (كجم / لتر / قطعة)، والسعر لكل وحدة شراء.</p>
        </div>
      </ConfirmDialog>
    </Card>
  );
}

function NewOrder({ scope, items, suppliers }: { scope: Scope; items: PurchasingItem[]; suppliers: Supplier[] }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [supplierId, setSupplierId] = useState('');
  const [lines, setLines] = useState<{ itemId: string; qty: string }[]>([{ itemId: '', qty: '' }]);

  function save() {
    const payload = lines.filter((l) => l.itemId && Number(l.qty) > 0).map((l) => {
      const it = items.find((i) => i.id === l.itemId)!;
      return { itemId: l.itemId, qty: fromInput(l.qty, it.unit), unitCostCents: it.avgCostCents };
    });
    if (!payload.length) { toast.error('أضف خامة وكمية'); return; }
    start(async () => {
      const r = await savePoAction(scope, { id: null, supplierId: supplierId || null, lines: payload });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success('أُنشئ طلب الشراء'); setOpen(false); setLines([{ itemId: '', qty: '' }]); router.refresh();
    });
  }

  if (!open) return <Button size="sm" variant="secondary" onClick={() => setOpen(true)}><Plus className="h-4 w-4" aria-hidden="true" /> طلب شراء يدوي</Button>;
  return (
    <Card>
      <CardBody className="space-y-2">
        <Select aria-label="المورد" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
          <option value="">بدون مورد محدد</option>
          {suppliers.filter((s) => s.isActive).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        {lines.map((l, idx) => {
          const it = items.find((i) => i.id === l.itemId);
          return (
            <div key={idx} className="grid grid-cols-[1fr_7rem_3rem] items-center gap-2">
              <Select aria-label="الخامة" value={l.itemId} onChange={(e) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, itemId: e.target.value } : x)))}>
                <option value="">— الخامة —</option>
                {items.filter((i) => i.isActive).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </Select>
              <Input aria-label="الكمية" dir="ltr" inputMode="decimal" placeholder={it ? buyUnit(it.unit) : ''} value={l.qty} onChange={(e) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, qty: e.target.value } : x)))} />
              <span className="text-xs text-muted">{it ? buyUnit(it.unit) : ''}</span>
            </div>
          );
        })}
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => setLines((ls) => [...ls, { itemId: '', qty: '' }])}><Plus className="h-4 w-4" aria-hidden="true" /> خامة</Button>
          <Button size="sm" disabled={pending} onClick={save}>حفظ كمسودة</Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>إلغاء</Button>
        </div>
      </CardBody>
    </Card>
  );
}

function LevelsPanel({ scope, items, thresholds, suppliers, can }: {
  scope: Scope; items: PurchasingItem[]; thresholds: Threshold[]; suppliers: Supplier[]; can: Can;
}) {
  const byItem = new Map(thresholds.map((t) => [t.itemId, t]));
  return (
    <Card>
      <CardHeader><CardTitle>الحد الأدنى في المخزن وكمية إعادة الطلب</CardTitle></CardHeader>
      <CardBody className="p-0">
        <p className="px-4 pb-2 text-xs text-muted">عند وصول الرصيد للحد الأدنى يُقترح شراء «كمية إعادة الطلب»؛ إن تُركت فارغة يُقترح ما يكفي لضعف الحد الأدنى.</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="levels">
            <thead className="border-b border-line text-xs text-muted">
              <tr><th className="p-2 text-start">الخامة</th><th className="p-2 text-end">الرصيد</th><th className="p-2 text-start">الحد الأدنى</th><th className="p-2 text-start">إعادة الطلب</th><th className="p-2 text-start">المورد المفضل</th><th className="p-2 text-end">سيُطلب</th><th className="p-2" /></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.filter((i) => i.isActive).map((i) => <LevelRow key={i.id} scope={scope} item={i} threshold={byItem.get(i.id) ?? null} suppliers={suppliers} can={can} />)}
            </tbody>
          </table>
        </div>
      </CardBody>
    </Card>
  );
}

function LevelRow({ scope, item, threshold, suppliers, can }: { scope: Scope; item: PurchasingItem; threshold: Threshold | null; suppliers: Supplier[]; can: Can }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [min, setMin] = useState(threshold ? toInput(threshold.minQty, item.unit) : '');
  const [reorder, setReorder] = useState(threshold?.reorderQty ? toInput(threshold.reorderQty, item.unit) : '');
  const onHand = threshold?.onHand ?? 0;
  const preview = min.trim() ? suggestedReorder({ onHand, minQty: fromInput(min, item.unit), reorderQty: reorder.trim() ? fromInput(reorder, item.unit) : null }) : 0;
  const dirty = min !== (threshold ? toInput(threshold.minQty, item.unit) : '') || reorder !== (threshold?.reorderQty ? toInput(threshold.reorderQty, item.unit) : '');

  function save() {
    start(async () => {
      const r = await saveThresholdAction(scope, {
        itemId: item.id, kind: 'warehouse', minQty: min.trim() ? fromInput(min, item.unit) : null,
        reorderQty: min.trim() && reorder.trim() ? fromInput(reorder, item.unit) : null,
      });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success(`تم حفظ حدود ${item.name}`); router.refresh();
    });
  }
  function supplier(id: string) {
    start(async () => {
      const r = await setItemSupplierAction(scope, { itemId: item.id, supplierId: id || null });
      if (!r.ok) { toast.error(r.error); return; }
      router.refresh();
    });
  }

  return (
    <tr className={cn(threshold?.belowMin && 'bg-amber-50/60 dark:bg-amber-950/20')}>
      <td className="p-2 font-medium">{item.name}</td>
      <td className="lb-numeric p-2 text-end">{formatQty(onHand, item.unit)}</td>
      <td className="p-2"><span className="inline-flex items-center gap-1"><Input aria-label={`الحد الأدنى ${item.name}`} dir="ltr" inputMode="decimal" className="h-8 w-20" disabled={!can.manage} value={min} onChange={(e) => setMin(e.target.value)} placeholder="—" /><span className="text-xs text-muted">{buyUnit(item.unit)}</span></span></td>
      <td className="p-2"><span className="inline-flex items-center gap-1"><Input aria-label={`إعادة الطلب ${item.name}`} dir="ltr" inputMode="decimal" className="h-8 w-20" disabled={!can.manage || !min.trim()} value={reorder} onChange={(e) => setReorder(e.target.value)} placeholder="تلقائي" /><span className="text-xs text-muted">{buyUnit(item.unit)}</span></span></td>
      <td className="p-2">
        <Select aria-label={`مورد ${item.name}`} className="h-8" value={item.supplierId ?? ''} disabled={!can.purchase || pending} onChange={(e) => supplier(e.target.value)}>
          <option value="">—</option>
          {suppliers.filter((s) => s.isActive || s.id === item.supplierId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
      </td>
      <td className="lb-numeric p-2 text-end text-xs">{preview > 0 ? formatQty(preview, item.unit) : '—'}</td>
      <td className="p-2 text-end">{can.manage && dirty && <Button size="sm" disabled={pending} onClick={save}>حفظ</Button>}</td>
    </tr>
  );
}

function SuppliersPanel({ scope, suppliers, canEdit }: { scope: Scope; suppliers: Supplier[]; canEdit: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [form, setForm] = useState<{ id: string | null; name: string; phone: string; notes: string; isActive: boolean } | null>(null);

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    start(async () => {
      const r = await saveSupplierAction(scope, { id: form.id, name: form.name, phone: form.phone || undefined, notes: form.notes || undefined, isActive: form.isActive });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success('تم حفظ المورد'); setForm(null); router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>الموردون</CardTitle>
        {canEdit && <Button size="sm" onClick={() => setForm({ id: null, name: '', phone: '', notes: '', isActive: true })}><Plus className="h-4 w-4" aria-hidden="true" /> مورد</Button>}
      </CardHeader>
      <CardBody className="space-y-3">
        {form && (
          <form onSubmit={save} className="grid gap-2 md:grid-cols-4" aria-label="المورد">
            <Input aria-label="اسم المورد" placeholder="اسم المورد" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={160} />
            <Input aria-label="الهاتف" placeholder="الهاتف" dir="ltr" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} maxLength={30} />
            <Input aria-label="ملاحظات" placeholder="ملاحظات (أيام التوريد…)" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} maxLength={500} />
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} /> فعّال</label>
              <Button type="submit" size="sm" disabled={pending}>حفظ</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setForm(null)}>إلغاء</Button>
            </div>
          </form>
        )}
        {suppliers.length === 0 ? <p className="text-sm text-muted">لا موردين. أضف موردًا وحدده لخاماته لتُجمَّع طلبات الشراء التلقائية لكل مورد.</p> : (
          <ul className="divide-y divide-line text-sm">
            {suppliers.map((s) => (
              <li key={s.id} className={cn('flex items-center justify-between py-2', !s.isActive && 'opacity-60')}>
                <span><span className="font-medium">{s.name}</span> {s.phone && <span dir="ltr" className="text-xs text-muted">{s.phone}</span>}{s.notes && <span className="block text-xs text-muted">{s.notes}</span>}</span>
                {canEdit && <Button size="sm" variant="ghost" onClick={() => setForm({ id: s.id, name: s.name, phone: s.phone ?? '', notes: s.notes ?? '', isActive: s.isActive })}>تعديل</Button>}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
