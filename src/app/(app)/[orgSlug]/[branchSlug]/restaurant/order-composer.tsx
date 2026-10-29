'use client';

import { useMemo, useState, useTransition } from 'react';
import { Check, Minus, Plus, Search, Send, ShoppingBag, StickyNote, Trash2, UtensilsCrossed } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Input } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { formatMoney } from '@/lib/money';
import { addOrderItemsAction, createHubOrderAction } from './actions';
import {
  cartLineCents, choiceErrors, lineKey,
  type CartLine, type PosMenuItem, type PosModifierGroup, type Scope,
} from './shared';

export type ComposerTarget =
  | { mode: 'new'; type: 'dine_in'; tableId: string; tableName: string }
  | { mode: 'new'; type: 'takeaway' }
  | { mode: 'add'; orderId: string; orderNumber: string; label: string };

const ALL = '__all';

/**
 * Taking an order — a new one for a table or a takeaway, or another round on
 * an open check. The guest's choices are validated here against each
 * modifier group's min/max so the waiter is told at once, and again by the
 * database, which is the copy that counts and the one that prices the order.
 */
export function OrderComposer({
  scope, currency, menu, groups, target, onClose, onDone,
}: {
  scope: Scope; currency: string; menu: PosMenuItem[]; groups: PosModifierGroup[];
  target: ComposerTarget; onClose: () => void; onDone: (orderId: string | null) => void;
}) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState(ALL);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [picking, setPicking] = useState<PosMenuItem | null>(null);
  const [sendToKitchen, setSendToKitchen] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const groupsByProduct = useMemo(() => {
    const m = new Map<string, PosModifierGroup[]>();
    for (const g of groups) m.set(g.productId, [...(m.get(g.productId) ?? []), g]);
    return m;
  }, [groups]);

  const categories = useMemo(() => {
    const seen = new Map<string, string>();
    for (const i of menu) if (i.categoryId && i.categoryName) seen.set(i.categoryId, i.categoryName);
    return [...seen.entries()];
  }, [menu]);

  const q = query.trim().toLowerCase();
  const visible = menu.filter((i) =>
    i.variants.some((v) => v.isAvailableHere) &&
    (category === ALL || i.categoryId === category) &&
    (!q || i.name.toLowerCase().includes(q)));

  function add(line: Omit<CartLine, 'key'>) {
    const key = lineKey(line.variantId, line.modifiers.map((m) => m.id), line.note);
    setCart((c) => {
      const hit = c.find((l) => l.key === key);
      return hit ? c.map((l) => (l.key === key ? { ...l, quantity: l.quantity + line.quantity } : l)) : [...c, { ...line, key }];
    });
  }

  function tap(item: PosMenuItem) {
    const variants = item.variants.filter((v) => v.isAvailableHere);
    const itemGroups = groupsByProduct.get(item.id) ?? [];
    if (variants.length === 1 && itemGroups.length === 0) {
      const v = variants[0]!;
      add({ productName: item.name, variantId: v.id, variantName: v.name, unitPriceCents: v.priceCents, modifiers: [], quantity: 1, note: '' });
      return;
    }
    setPicking(item);
  }

  function setQty(key: string, q: number) {
    setCart((c) => (q <= 0 ? c.filter((l) => l.key !== key) : c.map((l) => (l.key === key ? { ...l, quantity: Math.min(q, 999) } : l))));
  }

  const estimate = cart.reduce((s, l) => s + cartLineCents(l), 0);
  const units = cart.reduce((s, l) => s + l.quantity, 0);

  function submit() {
    if (cart.length === 0) return;
    setError(null);
    const items = cart.map((l) => ({
      variantId: l.variantId, quantity: l.quantity, modifierIds: l.modifiers.map((m) => m.id),
      note: l.note.trim() || undefined,
    }));
    start(async () => {
      if (target.mode === 'add') {
        const r = await addOrderItemsAction(scope, { orderId: target.orderId, items });
        if (!r.ok) { setError(r.error); return; }
        toast.success(`أُضيف ${r.data.added} صنف للطلب #${target.orderNumber} وأُرسل للمطبخ`);
        onDone(target.orderId);
        return;
      }
      const r = await createHubOrderAction(scope, {
        items,
        type: target.type,
        tableId: target.type === 'dine_in' ? target.tableId : null,
        sendToKitchen,
      });
      if (!r.ok) { setError(r.error); return; }
      if (sendToKitchen && !r.data.sentToKitchen) toast.error(`أُنشئ الطلب #${r.data.number} لكنه لم يُرسل للمطبخ — يرسله الكاشير أو المشرف`);
      else toast.success(`تم إنشاء الطلب #${r.data.number}${r.data.sentToKitchen ? ' وإرساله للمطبخ' : ''}`);
      onDone(r.data.id);
    });
  }

  const title = target.mode === 'add'
    ? `إضافة أصناف — ${target.label}`
    : target.type === 'dine_in' ? `طلب جديد — طاولة ${target.tableName}` : 'طلب تيك أواي جديد';

  return (
    <Modal open title={title} icon={target.mode === 'new' && target.type === 'takeaway' ? ShoppingBag : UtensilsCrossed}
      size="lg" onClose={onClose} busy={pending} testId="order-composer"
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            <span className="text-muted">{units} صنف · تقديري قبل الضريبة </span>
            <span className="font-bold lb-numeric">{formatMoney(estimate, currency)}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {target.mode === 'new' && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={sendToKitchen} onChange={(e) => setSendToKitchen(e.target.checked)} className="h-4 w-4" />
                إرسال للمطبخ فورًا
              </label>
            )}
            <Button variant="outline" onClick={onClose} disabled={pending}>إلغاء</Button>
            <Button onClick={submit} disabled={pending || cart.length === 0} data-testid="composer-submit">
              <Send className="h-4 w-4" aria-hidden="true" /> {target.mode === 'add' ? 'إضافة للطلب' : 'تأكيد الطلب'}
            </Button>
          </div>
        </div>
      }>
      <div className="grid gap-4 md:grid-cols-[1fr_16rem]">
        <section aria-label="المنيو" className="min-w-0 space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="ابحث في المنيو…" className="ps-9" aria-label="ابحث في المنيو" />
          </div>
          {categories.length > 1 && (
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {[[ALL, 'الكل'] as const, ...categories].map(([id, name]) => (
                <button key={id} type="button" onClick={() => setCategory(id)}
                  className={cn('shrink-0 rounded-full border px-3 py-1 text-xs font-semibold',
                    category === id ? 'border-primary bg-primary-soft text-primary' : 'border-line text-muted')}>
                  {name}
                </button>
              ))}
            </div>
          )}
          <ul className="grid max-h-[46vh] grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
            {visible.map((item) => {
              const from = Math.min(...item.variants.filter((v) => v.isAvailableHere).map((v) => v.priceCents));
              return (
                <li key={item.id}>
                  <button type="button" onClick={() => tap(item)} disabled={pending}
                    className="flex h-full min-h-[4.5rem] w-full flex-col justify-between rounded border border-line bg-elevated p-2 text-start hover:border-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                    data-testid={`menu-${item.name}`}>
                    <span className="text-sm font-semibold leading-tight">{item.name}</span>
                    <span className="mt-1 flex items-center justify-between gap-1 text-xs text-muted">
                      <span className="lb-numeric">{item.variants.length > 1 ? 'من ' : ''}{formatMoney(from, currency)}</span>
                      {(item.modifierGroupCount > 0 || item.variants.length > 1) && <span className="text-primary">خيارات</span>}
                    </span>
                  </button>
                </li>
              );
            })}
            {visible.length === 0 && <li className="col-span-full p-6 text-center text-sm text-muted">لا توجد أصناف مطابقة.</li>}
          </ul>
        </section>

        <section aria-label="الطلب" className="space-y-2">
          <h3 className="text-sm font-bold">الطلب</h3>
          {cart.length === 0 ? (
            <p className="rounded border border-dashed border-line p-4 text-center text-xs text-muted">اضغط على صنف لإضافته.</p>
          ) : (
            <ul className="max-h-[46vh] space-y-2 overflow-y-auto" data-testid="composer-cart">
              {cart.map((l) => (
                <li key={l.key} className="rounded border border-line p-2 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold leading-tight">{l.productName}{l.variantName !== 'default' && <span className="text-muted"> — {l.variantName}</span>}</p>
                      {l.modifiers.length > 0 && <p className="text-xs text-muted">{l.modifiers.map((m) => m.name).join('، ')}</p>}
                      {l.note && <p className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300"><StickyNote className="h-3 w-3" aria-hidden="true" />{l.note}</p>}
                    </div>
                    <button type="button" onClick={() => setQty(l.key, 0)} className="p-1 text-muted hover:text-danger" aria-label={`حذف ${l.productName}`}>
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className="flex items-center gap-1">
                      <button type="button" onClick={() => setQty(l.key, l.quantity - 1)} className="grid h-7 w-7 place-items-center rounded border border-line" aria-label="أقل"><Minus className="h-3 w-3" aria-hidden="true" /></button>
                      <span className="w-6 text-center font-bold lb-numeric">{l.quantity}</span>
                      <button type="button" onClick={() => setQty(l.key, l.quantity + 1)} className="grid h-7 w-7 place-items-center rounded border border-line" aria-label="أكثر"><Plus className="h-3 w-3" aria-hidden="true" /></button>
                    </span>
                    <span className="text-xs font-semibold lb-numeric">{formatMoney(cartLineCents(l), currency)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {error && <Alert tone="danger">{error}</Alert>}
        </section>
      </div>

      {picking && (
        <ItemPicker item={picking} groups={groupsByProduct.get(picking.id) ?? []} currency={currency}
          onCancel={() => setPicking(null)}
          onAdd={(line) => { add(line); setPicking(null); }} />
      )}
    </Modal>
  );
}

/** Size, modifiers, quantity and a note for one item. */
function ItemPicker({ item, groups, currency, onCancel, onAdd }: {
  item: PosMenuItem; groups: PosModifierGroup[]; currency: string;
  onCancel: () => void; onAdd: (line: Omit<CartLine, 'key'>) => void;
}) {
  const variants = item.variants.filter((v) => v.isAvailableHere);
  const [variantId, setVariantId] = useState(variants[0]?.id ?? '');
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const errors = choiceErrors(groups, chosen);
  const variant = variants.find((v) => v.id === variantId);
  const modifiers = groups.flatMap((g) => g.modifiers.filter((m) => (chosen[g.id] ?? []).includes(m.id)));
  const unit = (variant?.priceCents ?? 0) + modifiers.reduce((s, m) => s + m.priceCents, 0);

  function toggle(g: PosModifierGroup, id: string) {
    setChosen((c) => {
      const cur = c[g.id] ?? [];
      if (g.maxSelect === 1) return { ...c, [g.id]: cur.includes(id) && g.minSelect === 0 ? [] : [id] };
      if (cur.includes(id)) return { ...c, [g.id]: cur.filter((x) => x !== id) };
      if (cur.length >= g.maxSelect) return c;
      return { ...c, [g.id]: [...cur, id] };
    });
  }

  function confirm() {
    setTried(true);
    if (!variant || errors.length) return;
    onAdd({ productName: item.name, variantId: variant.id, variantName: variant.name, unitPriceCents: variant.priceCents, modifiers, quantity: qty, note });
  }

  return (
    <div role="dialog" aria-modal="true" aria-label={`خيارات ${item.name}`}
      className="absolute inset-0 z-10 flex items-end justify-center bg-fg/30 p-2 sm:items-center" data-testid="item-picker">
      <div className="max-h-full w-full max-w-md space-y-4 overflow-y-auto rounded-lg border border-line bg-elevated p-4 shadow-lg">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-base font-bold">{item.name}</h3>
          <span className="font-bold lb-numeric">{formatMoney(unit * qty, currency)}</span>
        </div>

        {variants.length > 1 && (
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-semibold">الحجم</legend>
            <div className="flex flex-wrap gap-2">
              {variants.map((v) => (
                <button key={v.id} type="button" onClick={() => setVariantId(v.id)} aria-pressed={v.id === variantId}
                  className={cn('rounded border px-3 py-1.5 text-sm', v.id === variantId ? 'border-primary bg-primary-soft text-primary' : 'border-line')}>
                  {v.name === 'default' ? 'عادي' : v.name} <span className="lb-numeric text-xs">{formatMoney(v.priceCents, currency)}</span>
                </button>
              ))}
            </div>
          </fieldset>
        )}

        {groups.map((g) => (
          <fieldset key={g.id} className="space-y-1.5">
            <legend className="flex items-center gap-2 text-sm font-semibold">
              {g.name}
              <span className="text-xs font-normal text-muted">
                {g.minSelect > 0 ? (g.minSelect === g.maxSelect ? `مطلوب ${g.minSelect}` : `${g.minSelect}–${g.maxSelect}`) : `اختياري، حتى ${g.maxSelect}`}
              </span>
            </legend>
            <div className="flex flex-wrap gap-2">
              {g.modifiers.map((m) => {
                const on = (chosen[g.id] ?? []).includes(m.id);
                return (
                  <button key={m.id} type="button" onClick={() => toggle(g, m.id)} aria-pressed={on}
                    className={cn('inline-flex items-center gap-1 rounded border px-3 py-1.5 text-sm', on ? 'border-primary bg-primary-soft text-primary' : 'border-line')}>
                    {on && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
                    {m.name}
                    {m.priceCents > 0 && <span className="lb-numeric text-xs">+{formatMoney(m.priceCents, currency)}</span>}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ))}

        <label className="block space-y-1 text-sm">
          <span className="font-semibold">ملاحظة للمطبخ</span>
          <Input value={note} onChange={(e) => setNote(e.target.value.slice(0, 200))} placeholder="مثال: حساسية من المكسرات" />
        </label>

        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1" aria-label="الكمية">
            <button type="button" onClick={() => setQty((q) => Math.max(1, q - 1))} className="grid h-9 w-9 place-items-center rounded border border-line" aria-label="أقل"><Minus className="h-4 w-4" aria-hidden="true" /></button>
            <span className="w-8 text-center text-lg font-bold lb-numeric">{qty}</span>
            <button type="button" onClick={() => setQty((q) => Math.min(99, q + 1))} className="grid h-9 w-9 place-items-center rounded border border-line" aria-label="أكثر"><Plus className="h-4 w-4" aria-hidden="true" /></button>
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onCancel}>رجوع</Button>
            <Button onClick={confirm} data-testid="picker-add">إضافة</Button>
          </div>
        </div>
        {tried && errors.length > 0 && <Alert tone="warn">{errors.join(' · ')}</Alert>}
      </div>
    </div>
  );
}
