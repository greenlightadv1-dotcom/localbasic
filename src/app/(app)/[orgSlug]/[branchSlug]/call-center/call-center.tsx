'use client';

import { useMemo, useRef, useState, useTransition } from 'react';
import { History, MapPin, Minus, Phone, Plus, RotateCcw, Search, Star, Trash2, UserPlus } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input, Select, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/cn';
import type { CallerAddress, CallerLookup, CallerOrder } from '@/modules/restaurant/callcenter/service';
import type { Zone } from '@/modules/restaurant/delivery/service';
import { lookupCallerAction, placePhoneOrderAction, saveAddressAction, saveCustomerAction } from './actions';

type Scope = { organizationSlug: string; branchSlug: string };
type Item = { variantId: string; productName: string; variantName: string; categoryName: string | null; priceCents: number };
type Line = { key: string; variantId: string; label: string; priceCents: number; quantity: number; note: string; modifierIds: string[] };

const date = (iso: string) => new Date(iso).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' });
const STATUS: Record<string, string> = { completed: 'مكتمل', cancelled: 'ملغي', served: 'تم التقديم', ready: 'جاهز', preparing: 'قيد التحضير', new: 'جديد', confirmed: 'مؤكد' };

/**
 * One screen for a ringing phone: number → who it is, where they live,
 * what they usually order → a confirmed order on the kitchen screen.
 */
export function CallCenter({ scope, currency, items, zones }: { scope: Scope; currency: string; items: Item[]; zones: Zone[] }) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const money = (c: number) => formatMoney(c, currency);
  const phoneRef = useRef<HTMLInputElement>(null);

  const [phone, setPhone] = useState('');
  const [found, setFound] = useState<CallerLookup | null>(null);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [addressKey, setAddressKey] = useState<string>('');
  const [addingAddress, setAddingAddress] = useState(false);
  const [addr, setAddr] = useState({ label: '', area: '', address: '', landmark: '', isDefault: false });
  const [type, setType] = useState<'delivery' | 'pickup'>('delivery');
  const [zoneId, setZoneId] = useState('');
  const [note, setNote] = useState('');
  const [cart, setCart] = useState<Line[]>([]);
  const [query, setQuery] = useState('');
  const [placed, setPlaced] = useState<{ number: string; totalCents: number } | null>(null);

  const customer = found?.customers.find((c) => c.id === customerId) ?? null;
  const addresses = useMemo(() => (found?.addresses ?? []).filter((a) => !a.customerId || a.customerId === customerId || !a.saved), [found, customerId]);
  const keyOf = (a: CallerAddress, i: number) => a.id ?? `past-${i}`;

  async function lookup(p = phone): Promise<void> {
    const r = await lookupCallerAction(scope, { phone: p });
    if (!r.ok) { toast.error(r.error); return; }
    setFound(r.data);
    setPlaced(null);
    const first = r.data.customers[0]?.id ?? null;
    setCustomerId(first);
    const def = r.data.addresses.findIndex((a) => a.isDefault && (!a.customerId || a.customerId === first));
    const pick = def >= 0 ? def : r.data.addresses.length ? 0 : -1;
    setAddressKey(pick >= 0 ? keyOf(r.data.addresses[pick]!, pick) : '');
    setAddingAddress(r.data.addresses.length === 0);
  }

  function search(e: React.FormEvent) { e.preventDefault(); start(() => lookup()); }

  function createCustomer() {
    start(async () => {
      const r = await saveCustomerAction(scope, { id: null, name: newName, phone });
      if (!r.ok) { toast.error(r.error); return; }
      setNewName('');
      await lookup();
    });
  }

  function saveAddr() {
    if (!customerId) return;
    start(async () => {
      const r = await saveAddressAction(scope, {
        customerId, id: null, label: addr.label || undefined, area: addr.area || undefined, address: addr.address,
        landmark: addr.landmark || undefined, isDefault: addr.isDefault, recipientName: customer?.name, phone: customer?.phone ?? phone,
      });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success('تم حفظ العنوان');
      setAddr({ label: '', area: '', address: '', landmark: '', isDefault: false });
      await lookup();
      setAddressKey(r.data.id);
      setAddingAddress(false);
    });
  }

  function add(i: Item) {
    setCart((c) => {
      const same = c.find((l) => l.variantId === i.variantId && !l.note && l.modifierIds.length === 0);
      if (same) return c.map((l) => (l === same ? { ...l, quantity: l.quantity + 1 } : l));
      return [...c, { key: crypto.randomUUID(), variantId: i.variantId, label: `${i.productName}${i.variantName && i.variantName !== i.productName ? ` — ${i.variantName}` : ''}`, priceCents: i.priceCents, quantity: 1, note: '', modifierIds: [] }];
    });
  }

  function repeat(o: CallerOrder) {
    const lines: Line[] = [];
    let missing = 0;
    for (const l of o.lines) {
      const i = items.find((x) => x.variantId === l.variantId);
      if (!i) { missing += 1; continue; }
      lines.push({ key: crypto.randomUUID(), variantId: i.variantId, label: `${l.productName}${l.variantName && l.variantName !== l.productName ? ` — ${l.variantName}` : ''}`, priceCents: i.priceCents, quantity: l.quantity, note: l.note ?? '', modifierIds: l.modifierIds });
    }
    setCart(lines);
    if (missing) toast.error(`${missing} صنف لم يعد متاحًا ولم يُضف`);
    else toast.success(`أُضيف طلب #${o.number} للسلة`);
  }

  const results = useMemo(() => {
    const q = query.trim();
    const list = q ? items.filter((i) => `${i.productName} ${i.variantName} ${i.categoryName ?? ''}`.includes(q)) : items;
    return list.slice(0, 60);
  }, [items, query]);

  const zone = zones.find((z) => z.id === zoneId);
  const subtotal = cart.reduce((s, l) => s + l.priceCents * l.quantity, 0);
  const fee = type === 'delivery' ? zone?.feeCents ?? 0 : 0;
  const selected = addresses.find((a, i) => keyOf(a, i) === addressKey);

  function place() {
    if (!customerId) { toast.error('اختر العميل أولًا'); return; }
    if (type === 'delivery' && !selected) { toast.error('اختر عنوان التوصيل'); return; }
    start(async () => {
      const r = await placePhoneOrderAction(scope, {
        customerId, type, note: note || undefined, confirm: true, zoneId: type === 'delivery' ? zoneId || null : null,
        items: cart.map((l) => ({ variantId: l.variantId, quantity: l.quantity, note: l.note || undefined, modifierIds: l.modifierIds })),
        addressId: type === 'delivery' && selected?.saved ? selected.id : null,
        address: type === 'delivery' && selected && !selected.saved
          ? { address: selected.address, area: selected.area ?? undefined, city: selected.city ?? undefined, landmark: selected.landmark ?? undefined } : null,
      });
      if (!r.ok) { toast.error(r.error); return; }
      setPlaced({ number: r.data.number, totalCents: r.data.totalCents });
      toast.success(`تم إرسال الطلب #${r.data.number} للمطبخ`);
      setCart([]); setNote('');
    });
  }

  function nextCall() {
    setPhone(''); setFound(null); setCustomerId(null); setCart([]); setPlaced(null); setNote(''); setZoneId('');
    phoneRef.current?.focus();
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[360px_1fr_360px]">
      {/* Caller */}
      <div className="space-y-3">
        <Card>
          <CardBody>
            <form onSubmit={search} className="flex gap-2" aria-label="بحث برقم الهاتف">
              <Input ref={phoneRef} autoFocus aria-label="رقم المتصل" placeholder="رقم المتصل" dir="ltr" inputMode="tel" value={phone}
                onChange={(e) => setPhone(e.target.value)} maxLength={30} data-testid="cc-phone" />
              <Button type="submit" disabled={pending || phone.trim().length < 7} data-testid="cc-search"><Search className="h-4 w-4" aria-hidden="true" /> بحث</Button>
            </form>
          </CardBody>
        </Card>

        {found && (
          <Card data-testid="cc-caller">
            <CardHeader><CardTitle className="flex items-center gap-2"><Phone className="h-4 w-4" aria-hidden="true" /> المتصل</CardTitle></CardHeader>
            <CardBody className="space-y-3">
              {found.customers.length === 0 ? (
                <div className="space-y-2">
                  <p className="text-sm text-muted">رقم جديد — سجّل العميل:</p>
                  <Input aria-label="اسم العميل" placeholder="اسم العميل" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={160} data-testid="cc-new-name" />
                  <Button size="sm" block disabled={pending || !newName.trim()} onClick={createCustomer} data-testid="cc-create"><UserPlus className="h-4 w-4" aria-hidden="true" /> تسجيل العميل</Button>
                </div>
              ) : (
                <>
                  {found.customers.length > 1 ? (
                    <Select aria-label="العميل" value={customerId ?? ''} onChange={(e) => setCustomerId(e.target.value)}>
                      {found.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </Select>
                  ) : <p className="text-lg font-bold">{customer?.name}</p>}
                  {customer?.notes && <p className="rounded bg-amber-50 p-2 text-xs text-amber-900">{customer.notes}</p>}
                  <p className="flex items-center gap-1 text-sm"><Star className="h-4 w-4 text-amber-500" aria-hidden="true" /> نقاط الولاء: <strong className="lb-numeric">{found.points}</strong></p>
                </>
              )}
            </CardBody>
          </Card>
        )}

        {found && customerId && (
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><MapPin className="h-4 w-4" aria-hidden="true" /> العناوين</CardTitle></CardHeader>
            <CardBody className="space-y-2">
              {addresses.map((a, i) => (
                <label key={keyOf(a, i)} className={cn('flex cursor-pointer items-start gap-2 rounded border p-2 text-sm', addressKey === keyOf(a, i) ? 'border-primary bg-primary-soft' : 'border-line')}>
                  <input type="radio" name="cc-address" checked={addressKey === keyOf(a, i)} onChange={() => setAddressKey(keyOf(a, i))} />
                  <span>
                    <span className="font-medium">{a.label || (a.saved ? 'عنوان' : 'من طلب سابق')}</span>
                    {a.isDefault && <Badge tone="info" className="ms-1">افتراضي</Badge>}
                    <span className="block text-xs text-muted">{[a.area, a.address, a.landmark].filter(Boolean).join(' — ')}</span>
                  </span>
                </label>
              ))}
              {addingAddress ? (
                <div className="space-y-2 rounded border border-dashed border-line p-2">
                  <div className="flex gap-2">
                    <Input aria-label="اسم العنوان" placeholder="المنزل / العمل" value={addr.label} onChange={(e) => setAddr({ ...addr, label: e.target.value })} maxLength={60} />
                    <Input aria-label="المنطقة" placeholder="المنطقة" value={addr.area} onChange={(e) => setAddr({ ...addr, area: e.target.value })} maxLength={120} />
                  </div>
                  <Textarea aria-label="العنوان" placeholder="الشارع، العمارة، الدور، الشقة" value={addr.address} onChange={(e) => setAddr({ ...addr, address: e.target.value })} maxLength={500} rows={2} data-testid="cc-address" />
                  <Input aria-label="علامة مميزة" placeholder="علامة مميزة" value={addr.landmark} onChange={(e) => setAddr({ ...addr, landmark: e.target.value })} maxLength={240} />
                  <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={addr.isDefault} onChange={(e) => setAddr({ ...addr, isDefault: e.target.checked })} /> العنوان الافتراضي</label>
                  <div className="flex gap-2">
                    <Button size="sm" disabled={pending || addr.address.trim().length < 5} onClick={saveAddr} data-testid="cc-save-address">حفظ العنوان</Button>
                    {addresses.length > 0 && <Button size="sm" variant="ghost" onClick={() => setAddingAddress(false)}>إلغاء</Button>}
                  </div>
                </div>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setAddingAddress(true)}><Plus className="h-4 w-4" aria-hidden="true" /> عنوان جديد</Button>
              )}
            </CardBody>
          </Card>
        )}

        {found && found.orders.length > 0 && (
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><History className="h-4 w-4" aria-hidden="true" /> آخر الطلبات</CardTitle></CardHeader>
            <CardBody className="space-y-2">
              {found.orders.map((o) => (
                <div key={o.id} className="rounded border border-line p-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">#{o.number} <span className="text-xs text-muted">{date(o.placedAt)}</span></span>
                    <span className="lb-numeric">{money(o.totalCents)}</span>
                  </div>
                  <p className="text-xs text-muted">{o.lines.map((l) => `${l.quantity}× ${l.productName}`).join('، ')}</p>
                  <div className="mt-1 flex items-center justify-between">
                    <Badge tone={o.status === 'cancelled' ? 'danger' : 'neutral'}>{STATUS[o.status] ?? o.status}</Badge>
                    <Button size="sm" variant="ghost" onClick={() => repeat(o)} data-testid="cc-repeat"><RotateCcw className="h-4 w-4" aria-hidden="true" /> كرّر</Button>
                  </div>
                </div>
              ))}
            </CardBody>
          </Card>
        )}
      </div>

      {/* Menu */}
      <Card>
        <CardHeader><CardTitle>المنيو</CardTitle></CardHeader>
        <CardBody className="space-y-2">
          <Input aria-label="بحث في المنيو" placeholder="ابحث عن صنف…" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="cc-menu-search" />
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {results.map((i) => (
              <button key={i.variantId} type="button" onClick={() => add(i)}
                className="rounded border border-line p-2 text-start text-sm hover:border-primary" data-testid="cc-item">
                <span className="block font-medium">{i.productName}</span>
                {i.variantName && i.variantName !== i.productName && <span className="block text-xs text-muted">{i.variantName}</span>}
                <span className="lb-numeric text-xs">{money(i.priceCents)}</span>
              </button>
            ))}
          </div>
        </CardBody>
      </Card>

      {/* Order */}
      <Card data-testid="cc-cart">
        <CardHeader><CardTitle>الطلب</CardTitle></CardHeader>
        <CardBody className="space-y-3">
          {placed && (
            <div className="space-y-2 rounded border border-green-300 bg-green-50 p-3 text-sm" data-testid="cc-placed">
              <p>تم إرسال الطلب <strong>#{placed.number}</strong> للمطبخ — الإجمالي <strong className="lb-numeric">{money(placed.totalCents)}</strong></p>
              <Button size="sm" onClick={nextCall}>مكالمة جديدة</Button>
            </div>
          )}
          <div className="flex gap-1">
            {([['delivery', 'توصيل'], ['pickup', 'استلام من الفرع']] as const).map(([k, l]) => (
              <button key={k} type="button" onClick={() => setType(k)}
                className={cn('flex-1 rounded border px-2 py-1 text-sm', type === k ? 'border-primary bg-primary-soft text-primary' : 'border-line')}>{l}</button>
            ))}
          </div>
          {type === 'delivery' && zones.length > 0 && (
            <Select aria-label="منطقة التوصيل" value={zoneId} onChange={(e) => setZoneId(e.target.value)} data-testid="cc-zone">
              <option value="">— منطقة التوصيل —</option>
              {zones.map((z) => <option key={z.id} value={z.id}>{z.name} ({money(z.feeCents)})</option>)}
            </Select>
          )}
          {cart.length === 0 ? <p className="text-center text-sm text-muted">اختر أصنافًا من المنيو أو كرّر طلبًا سابقًا.</p> : (
            <ul className="divide-y divide-line text-sm">
              {cart.map((l) => (
                <li key={l.key} className="space-y-1 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex-1">{l.label}</span>
                    <span className="lb-numeric">{money(l.priceCents * l.quantity)}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant="ghost" aria-label="إنقاص" onClick={() => setCart((c) => c.map((x) => (x.key === l.key ? { ...x, quantity: Math.max(1, x.quantity - 1) } : x)))}><Minus className="h-3 w-3" /></Button>
                    <span className="lb-numeric w-6 text-center">{l.quantity}</span>
                    <Button size="sm" variant="ghost" aria-label="زيادة" onClick={() => setCart((c) => c.map((x) => (x.key === l.key ? { ...x, quantity: x.quantity + 1 } : x)))}><Plus className="h-3 w-3" /></Button>
                    <Input aria-label="ملاحظة الصنف" placeholder="ملاحظة" className="h-8 flex-1 text-xs" value={l.note} onChange={(e) => setCart((c) => c.map((x) => (x.key === l.key ? { ...x, note: e.target.value } : x)))} maxLength={200} />
                    <Button size="sm" variant="ghost" aria-label="حذف" onClick={() => setCart((c) => c.filter((x) => x.key !== l.key))}><Trash2 className="h-3 w-3" /></Button>
                  </div>
                  {l.modifierIds.length > 0 && <p className="text-xs text-muted">+ {l.modifierIds.length} إضافة من الطلب السابق</p>}
                </li>
              ))}
            </ul>
          )}
          <Textarea aria-label="ملاحظة الطلب" placeholder="ملاحظة للطلب" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} />
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between"><dt>الأصناف</dt><dd className="lb-numeric">{money(subtotal)}</dd></div>
            {type === 'delivery' && <div className="flex justify-between"><dt>التوصيل</dt><dd className="lb-numeric">{zone ? money(fee) : '—'}</dd></div>}
            <div className="flex justify-between font-bold"><dt>تقريبي</dt><dd className="lb-numeric">{money(subtotal + fee)}</dd></div>
          </dl>
          <p className="text-xs text-muted">الإجمالي النهائي (الضريبة والإضافات) يحسبه النظام عند الإرسال.</p>
          <Button block size="lg" disabled={pending || !customerId || cart.length === 0 || (type === 'delivery' && !selected)} onClick={place} data-testid="cc-place">
            إرسال الطلب للمطبخ
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}
