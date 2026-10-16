'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Bike, CheckCircle2, MapPin, Navigation, Phone, Plus, RotateCcw, Send, Truck, Wallet } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Field, Input, Select } from '@/components/ui/field';
import { ConfirmDialog } from '@/components/ui/confirm';
import { useToast } from '@/components/ui/toast';
import { useApproval } from '@/components/patterns/approval-dialog';
import { useLiveOrders } from '@/lib/realtime/use-live-orders';
import { formatMoney } from '@/lib/money';
import { fromCents, toCents } from '@/lib/amount-input';
import { cn } from '@/lib/cn';
import type { DispatchOrder, Driver, JobStatus, Zone } from '@/modules/restaurant/delivery/service';
import {
  adjustDriverAction, assignDriverAction, giveFloatAction, saveDriverAction, saveZoneAction,
  setDeliveryStatusAction, setShiftAction, settleDriverAction,
} from './actions';

type Scope = { organizationSlug: string; branchSlug: string };
type Can = { dispatch: boolean; manage: boolean; settle: boolean };

export const JOB_LABEL: Record<JobStatus, string> = {
  pending: 'بانتظار مندوب', assigned: 'مُعيّن', dispatched: 'خرج', in_transit: 'في الطريق',
  delivered: 'تم التسليم', returned: 'مرتجع', cancelled: 'ملغي',
};
const KITCHEN_LABEL: Record<string, string> = {
  new: 'جديد', confirmed: 'مؤكد', preparing: 'قيد التحضير', ready: 'جاهز', served: 'مع المندوب', completed: 'مكتمل',
};
const time = (iso: string) => new Date(iso).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

/**
 * The dispatcher's screen: delivery orders by stage, the drivers on shift
 * with what they hold, and the money desk (float, settlement, adjustments).
 * Every money move that needs a manager answers approval_required and the
 * PIN dialog retries it.
 */
export function DispatchView({ scope, branchId, currency, orders, drivers, zones, members, can }: {
  scope: Scope; branchId: string; currency: string; orders: DispatchOrder[]; drivers: Driver[]; zones: Zone[];
  members: { memberId: string; name: string }[]; can: Can;
}) {
  useLiveOrders(branchId, 'delivery', 10_000);
  const [tab, setTab] = useState<'board' | 'drivers' | 'zones'>(can.dispatch ? 'board' : 'drivers');
  const money = (c: number) => formatMoney(c, currency);

  const columns = useMemo(() => {
    const stage = (o: DispatchOrder) => {
      const s = o.job?.status ?? 'pending';
      if (s === 'pending') return 'pending';
      if (s === 'assigned') return 'assigned';
      if (s === 'dispatched' || s === 'in_transit') return 'road';
      if (s === 'delivered' && !o.job?.settledAt) return 'settle';
      return null;
    };
    const by: Record<'pending' | 'assigned' | 'road' | 'settle', DispatchOrder[]> = { pending: [], assigned: [], road: [], settle: [] };
    for (const o of orders) { const k = stage(o); if (k) by[k].push(o); }
    return by;
  }, [orders]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1" role="tablist">
        {([
          ['board', 'لوحة التوزيع', can.dispatch], ['drivers', `المناديب (${drivers.filter((d) => d.onShift).length} في الوردية)`, true],
          ['zones', 'مناطق التوصيل', can.manage || can.dispatch],
        ] as const).filter(([, , show]) => show).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={cn('rounded border px-3 py-1.5 text-sm', tab === k ? 'border-primary bg-primary-soft text-primary' : 'border-line')}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'board' && (
        <div className="grid gap-3 lg:grid-cols-4" data-testid="dispatch-board">
          {([
            ['pending', 'بانتظار مندوب', columns.pending], ['assigned', 'مُعيّن — ينتظر المطبخ', columns.assigned],
            ['road', 'في الطريق', columns.road], ['settle', 'سُلّم — بانتظار التوريد', columns.settle],
          ] as const).map(([k, title, list]) => (
            <Card key={k}>
              <CardHeader><CardTitle className="flex items-center justify-between text-sm">{title} <Badge tone={list.length ? 'info' : 'neutral'}>{list.length}</Badge></CardTitle></CardHeader>
              <CardBody className="space-y-2">
                {list.length === 0 ? <p className="text-center text-xs text-muted">لا شيء هنا.</p>
                  : list.map((o) => <OrderCard key={o.orderId} scope={scope} order={o} drivers={drivers} zones={zones} money={money} />)}
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {tab === 'drivers' && <DriversPanel scope={scope} drivers={drivers} members={members} money={money} can={can} />}
      {tab === 'zones' && <ZonesPanel scope={scope} zones={zones} money={money} canManage={can.manage} />}
    </div>
  );
}

function OrderCard({ scope, order, drivers, zones, money }: {
  scope: Scope; order: DispatchOrder; drivers: Driver[]; zones: Zone[]; money: (c: number) => string;
}) {
  const router = useRouter();
  const toast = useToast();
  const approval = useApproval(scope);
  const [pending, start] = useTransition();
  const [driverId, setDriverId] = useState(order.job?.driverId ?? '');
  const [zoneId, setZoneId] = useState(order.job?.zoneId ?? '');
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState('');
  const status = order.job?.status ?? 'pending';
  const due = Math.max(order.totalCents - order.paidCents, 0);
  const driver = drivers.find((d) => d.id === order.job?.driverId);
  const available = drivers.filter((d) => d.isActive && (d.onShift || d.id === order.job?.driverId));

  function assign() {
    start(async () => {
      const r = await assignDriverAction(scope, { orderId: order.orderId, driverId: driverId || null, zoneId: zoneId || null });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success(driverId ? 'تم تعيين المندوب' : 'أُلغي التعيين');
      router.refresh();
    });
  }

  async function move(next: 'dispatched' | 'in_transit' | 'delivered' | 'returned', why?: string): Promise<void> {
    const r = await setDeliveryStatusAction(scope, { orderId: order.orderId, status: next, reason: why });
    if (!r.ok) {
      // Returning food the kitchen made is a cancellation: manager PIN.
      if (r.code === 'approval_required') { approval.request('order.cancel', order.orderId, null, () => move(next, why)); return; }
      toast.error(r.error); return;
    }
    toast.success({ dispatched: 'خرج الطلب', in_transit: 'في الطريق', delivered: 'تم التسليم', returned: 'سُجّل المرتجع' }[next]);
    setReturning(false); setReason('');
    router.refresh();
  }

  return (
    <div className="rounded border border-line p-2 text-sm" data-testid={`dispatch-${order.number}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-bold">#{order.number} <span className="text-xs font-normal text-muted">{time(order.placedAt)}</span></p>
          <p className="text-xs">{order.guestName ?? order.address?.recipient ?? '—'}</p>
        </div>
        <div className="text-end">
          <p className="lb-numeric font-bold">{money(order.totalCents)}</p>
          {due > 0 ? <Badge tone="warn">تحصيل {money(due)}</Badge> : <Badge tone="success">مدفوع</Badge>}
        </div>
      </div>
      {order.address && (
        <p className="mt-1 flex items-start gap-1 text-xs text-muted">
          <MapPin className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          {[order.address.area, order.address.address, order.address.landmark].filter(Boolean).join(' — ')}
        </p>
      )}
      {(order.guestPhone || order.address?.phone) && (
        <a href={`tel:${order.address?.phone ?? order.guestPhone}`} className="mt-1 flex items-center gap-1 text-xs text-primary" dir="ltr">
          <Phone className="h-3 w-3" aria-hidden="true" /> {order.address?.phone ?? order.guestPhone}
        </a>
      )}
      <div className="mt-1 flex flex-wrap gap-1">
        <Badge tone={order.orderStatus === 'ready' ? 'success' : 'neutral'}>المطبخ: {KITCHEN_LABEL[order.orderStatus] ?? order.orderStatus}</Badge>
        {status !== 'pending' && <Badge tone="info">{JOB_LABEL[status]}{driver ? ` · ${driver.name}` : ''}</Badge>}
      </div>

      {(status === 'pending' || status === 'assigned') && (
        <div className="mt-2 space-y-1">
          <div className="flex gap-1">
            <Select aria-label="المندوب" value={driverId} onChange={(e) => setDriverId(e.target.value)} className="flex-1 text-xs">
              <option value="">— المندوب —</option>
              {available.map((d) => <option key={d.id} value={d.id}>{d.name}{d.activeTrips ? ` (${d.activeTrips})` : ''}</option>)}
            </Select>
            <Select aria-label="المنطقة" value={zoneId} onChange={(e) => setZoneId(e.target.value)} className="flex-1 text-xs">
              <option value="">— المنطقة —</option>
              {zones.filter((z) => z.isActive || z.id === zoneId).map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
            </Select>
          </div>
          <div className="flex gap-1">
            <Button size="sm" variant="secondary" className="flex-1" disabled={pending} onClick={assign} data-testid="assign">
              <Bike className="h-4 w-4" aria-hidden="true" /> {status === 'assigned' ? 'تحديث' : 'تعيين'}
            </Button>
            {status === 'assigned' && (
              <Button size="sm" className="flex-1" disabled={pending || order.orderStatus !== 'ready'} title={order.orderStatus !== 'ready' ? 'بانتظار المطبخ' : undefined}
                onClick={() => start(() => move('dispatched'))} data-testid="dispatch">
                <Send className="h-4 w-4" aria-hidden="true" /> خروج
              </Button>
            )}
          </div>
        </div>
      )}

      {(status === 'dispatched' || status === 'in_transit') && (
        <div className="mt-2 flex flex-wrap gap-1">
          {status === 'dispatched' && (
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => start(() => move('in_transit'))}>
              <Navigation className="h-4 w-4" aria-hidden="true" /> في الطريق
            </Button>
          )}
          <Button size="sm" disabled={pending} onClick={() => start(() => move('delivered'))} data-testid="delivered">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> تم التسليم
          </Button>
          <Button size="sm" variant="ghost" disabled={pending || order.paidCents > 0} onClick={() => setReturning(true)}>
            <RotateCcw className="h-4 w-4" aria-hidden="true" /> مرتجع
          </Button>
        </div>
      )}

      {status === 'delivered' && order.job && (
        <p className="mt-1 text-xs text-muted">مع {driver?.name ?? 'المندوب'}: <span className="lb-numeric">{money(order.job.cashToCollectCents)}</span> · عمولة <span className="lb-numeric">{money(order.job.commissionCents)}</span></p>
      )}

      <ConfirmDialog open={returning} title={`مرتجع الطلب #${order.number}`} description="يُلغى الطلب ويُسجّل طعامه هالكًا. قد يحتاج موافقة المدير."
        confirmLabel="تسجيل المرتجع" busy={pending} onCancel={() => setReturning(false)}
        onConfirm={() => { if (reason.trim()) start(() => move('returned', reason.trim())); }}>
        <Input aria-label="سبب الإرجاع" placeholder="سبب الإرجاع (العميل لم يرد، رفض الاستلام…)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
      </ConfirmDialog>
      {approval.dialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------
const MODE_LABEL = { zone: 'حسب المنطقة', percent: 'نسبة من الطلب', fixed: 'مبلغ ثابت لكل طلب' } as const;
type DriverForm = { id: string | null; name: string; phone: string; vehicle: string; memberId: string; mode: Driver['mode']; percent: string; fixed: string; isActive: boolean };
const emptyDriver: DriverForm = { id: null, name: '', phone: '', vehicle: '', memberId: '', mode: 'zone', percent: '', fixed: '', isActive: true };

function DriversPanel({ scope, drivers, members, money, can }: {
  scope: Scope; drivers: Driver[]; members: { memberId: string; name: string }[]; money: (c: number) => string; can: Can;
}) {
  const router = useRouter();
  const toast = useToast();
  const approval = useApproval(scope);
  const [pending, start] = useTransition();
  const [form, setForm] = useState<DriverForm | null>(null);
  const [desk, setDesk] = useState<{ driver: Driver; kind: 'float' | 'settle' | 'adjust' } | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [payCommission, setPayCommission] = useState(true);

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    start(async () => {
      const r = await saveDriverAction(scope, {
        id: form.id, name: form.name, phone: form.phone, vehicle: form.vehicle, memberId: form.memberId || null, mode: form.mode,
        percentBp: Math.round((Number(form.percent) || 0) * 100), fixedCents: toCents(form.fixed || '0') ?? 0, isActive: form.isActive,
      });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success('تم حفظ المندوب'); setForm(null); router.refresh();
    });
  }

  function shift(d: Driver) {
    start(async () => {
      const r = await setShiftAction(scope, { driverId: d.id, on: !d.onShift });
      if (!r.ok) { toast.error(r.error); return; }
      router.refresh();
    });
  }

  function openDesk(driver: Driver, kind: 'float' | 'settle' | 'adjust') {
    setDesk({ driver, kind }); setNote(''); setPayCommission(driver.commissionCents > 0);
    setAmount(kind === 'settle' ? fromCents(driver.custodyCents) : '');
  }

  // A settlement can need two PINs (shortage, then the commission payout):
  // each approval_required asks for the next one and retries.
  async function runDesk(granted: string[] = []): Promise<void> {
    if (!desk) return;
    const d = desk.driver;
    const cents = toCents(amount, { allowNegative: desk.kind === 'adjust' });
    if (cents === null || (desk.kind !== 'settle' && cents === 0)) { toast.error('المبلغ غير صالح'); return; }
    const r = desk.kind === 'float' ? await giveFloatAction(scope, { driverId: d.id, amountCents: cents, note: note || undefined })
      : desk.kind === 'adjust' ? await adjustDriverAction(scope, { driverId: d.id, amountCents: cents, note })
      : await settleDriverAction(scope, { driverId: d.id, cashCents: cents, payCommission });
    if (!r.ok) {
      if (r.code === 'approval_required') {
        if (desk.kind === 'adjust') { approval.request('driver.adjust', d.id, Math.abs(cents), () => runDesk(granted)); return; }
        const shortage = d.custodyCents - cents;
        const next = shortage > 0 && !granted.includes('driver.shortage') ? 'driver.shortage' : 'driver.payout';
        approval.request(next, d.id, next === 'driver.shortage' ? shortage : d.commissionCents, () => runDesk([...granted, next]));
        return;
      }
      toast.error(r.error); return;
    }
    if (desk.kind === 'settle' && 'data' in r && r.data && 'orders' in r.data) {
      const s = r.data;
      toast.success(`تم التوريد: ${s.orders} طلب · ${money(s.collected)}${s.shortage ? ` · عجز ${money(s.shortage)}` : ''}${s.commissionPaid ? ` · صُرفت عمولة ${money(s.commissionPaid)}` : ''}`);
    } else toast.success(desk.kind === 'float' ? 'تم تسليم العهدة' : 'تمت التسوية');
    setDesk(null); router.refresh();
  }

  return (
    <div className="space-y-3">
      {can.manage && <div><Button size="sm" onClick={() => setForm(emptyDriver)}><Plus className="h-4 w-4" aria-hidden="true" /> مندوب جديد</Button></div>}
      {form && (
        <Card>
          <CardBody>
            <form onSubmit={save} className="grid gap-3 md:grid-cols-4" aria-label="بيانات المندوب">
              <Field label="الاسم" required>{(p) => <Input {...p} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={80} required />}</Field>
              <Field label="الهاتف">{(p) => <Input {...p} dir="ltr" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} maxLength={30} />}</Field>
              <Field label="المركبة">{(p) => <Input {...p} value={form.vehicle} onChange={(e) => setForm({ ...form, vehicle: e.target.value })} maxLength={60} placeholder="موتوسيكل — 1234" />}</Field>
              <Field label="حساب الدخول" hint="موظف بدور «مندوب» ليرى رحلاته">{(p) => (
                <Select {...p} value={form.memberId} onChange={(e) => setForm({ ...form, memberId: e.target.value })}>
                  <option value="">بدون (مندوب خارجي)</option>
                  {members.map((m) => <option key={m.memberId} value={m.memberId}>{m.name}</option>)}
                </Select>
              )}</Field>
              <Field label="طريقة العمولة">{(p) => (
                <Select {...p} value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as Driver['mode'] })}>
                  {Object.entries(MODE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </Select>
              )}</Field>
              {form.mode === 'percent' && <Field label="النسبة %">{(p) => <Input {...p} dir="ltr" inputMode="decimal" value={form.percent} onChange={(e) => setForm({ ...form, percent: e.target.value })} />}</Field>}
              {form.mode === 'fixed' && <Field label="المبلغ لكل طلب">{(p) => <Input {...p} dir="ltr" inputMode="decimal" value={form.fixed} onChange={(e) => setForm({ ...form, fixed: e.target.value })} />}</Field>}
              {form.mode === 'zone' && <p className="self-end text-xs text-muted">العمولة = «أجر المندوب» المحدد في منطقة التوصيل.</p>}
              <label className="flex items-center gap-2 self-end text-sm"><input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} /> فعّال</label>
              <div className="flex gap-2 self-end md:col-span-4">
                <Button type="submit" size="sm" disabled={pending}>حفظ</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setForm(null)}>إلغاء</Button>
              </div>
            </form>
          </CardBody>
        </Card>
      )}

      {drivers.length === 0 ? <p className="text-sm text-muted">لا يوجد مناديب بعد.</p> : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="drivers">
          {drivers.map((d) => (
            <Card key={d.id} className={cn(!d.isActive && 'opacity-60')}>
              <CardBody className="space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="flex items-center gap-1.5 font-bold"><Truck className="h-4 w-4" aria-hidden="true" /> {d.name}</p>
                    <p className="text-xs text-muted">{MODE_LABEL[d.mode]}{d.mode === 'percent' ? ` ${d.percentBp / 100}%` : d.mode === 'fixed' ? ` ${money(d.fixedCents)}` : ''}{d.vehicle ? ` · ${d.vehicle}` : ''}</p>
                  </div>
                  <Badge tone={d.onShift ? 'success' : 'neutral'}>{d.onShift ? 'في الوردية' : 'خارج الوردية'}</Badge>
                </div>
                <dl className="grid grid-cols-3 gap-1 text-center text-xs">
                  <div className="rounded bg-surface p-1"><dt className="text-muted">العهدة</dt><dd className="lb-numeric font-bold">{money(d.custodyCents)}</dd></div>
                  <div className="rounded bg-surface p-1"><dt className="text-muted">عمولة مستحقة</dt><dd className="lb-numeric font-bold">{money(d.commissionCents)}</dd></div>
                  <div className="rounded bg-surface p-1"><dt className="text-muted">رحلات</dt><dd className="lb-numeric font-bold">{d.activeTrips}</dd></div>
                </dl>
                <div className="flex flex-wrap gap-1">
                  {can.dispatch && <Button size="sm" variant="secondary" disabled={pending || !d.isActive} onClick={() => shift(d)}>{d.onShift ? 'إنهاء الوردية' : 'بدء الوردية'}</Button>}
                  {can.settle && <Button size="sm" variant="secondary" disabled={pending} onClick={() => openDesk(d, 'float')}><Wallet className="h-4 w-4" aria-hidden="true" /> عهدة</Button>}
                  {can.settle && <Button size="sm" disabled={pending || (d.custodyCents === 0 && d.commissionCents === 0)} onClick={() => openDesk(d, 'settle')} data-testid="settle">توريد</Button>}
                  {can.manage && <Button size="sm" variant="ghost" onClick={() => openDesk(d, 'adjust')}>تسوية</Button>}
                  {can.manage && <Button size="sm" variant="ghost" onClick={() => setForm({ id: d.id, name: d.name, phone: d.phone ?? '', vehicle: d.vehicle ?? '', memberId: d.memberId ?? '', mode: d.mode, percent: String(d.percentBp / 100), fixed: fromCents(d.fixedCents), isActive: d.isActive })}>تعديل</Button>}
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(desk)} tone="primary" busy={pending}
        title={desk ? { float: `تسليم عهدة نقدية — ${desk.driver.name}`, settle: `توريد ${desk.driver.name}`, adjust: `تسوية عمولة — ${desk.driver.name}` }[desk.kind] : ''}
        description={desk?.kind === 'settle'
          ? `العهدة الحالية ${money(desk.driver.custodyCents)}. اكتب ما سلّمه فعلًا؛ العجز يحتاج موافقة المدير.`
          : desk?.kind === 'adjust' ? 'موجب يزيد العمولة المستحقة وسالب يخصم منها (يحتاج موافقة المدير).' : 'فكة يخرج بها المندوب من الخزينة وتُضاف لعهدته.'}
        confirmLabel="تأكيد" onCancel={() => setDesk(null)} onConfirm={() => start(() => runDesk())}>
        <div className="space-y-2">
          <Input aria-label="المبلغ" dir="ltr" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" data-testid="desk-amount" />
          {desk?.kind === 'settle' && desk.driver.commissionCents > 0 && (
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={payCommission} onChange={(e) => setPayCommission(e.target.checked)} /> صرف العمولة المستحقة ({money(desk.driver.commissionCents)})</label>
          )}
          {desk?.kind !== 'settle' && <Input aria-label="ملاحظة" placeholder={desk?.kind === 'adjust' ? 'السبب (مطلوب)' : 'ملاحظة'} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />}
        </div>
      </ConfirmDialog>
      {approval.dialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------
function ZonesPanel({ scope, zones, money, canManage }: { scope: Scope; zones: Zone[]; money: (c: number) => string; canManage: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [form, setForm] = useState<{ id: string | null; name: string; fee: string; driverFee: string; isActive: boolean } | null>(null);

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    const fee = toCents(form.fee || '0'); const driverFee = toCents(form.driverFee || '0');
    if (fee === null || driverFee === null) { toast.error('المبلغ غير صالح'); return; }
    start(async () => {
      const r = await saveZoneAction(scope, { id: form.id, name: form.name, feeCents: fee, driverFeeCents: driverFee, isActive: form.isActive });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success('تم حفظ المنطقة'); setForm(null); router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>مناطق التوصيل</CardTitle>
        {canManage && <Button size="sm" onClick={() => setForm({ id: null, name: '', fee: '', driverFee: '', isActive: true })}><Plus className="h-4 w-4" aria-hidden="true" /> منطقة</Button>}
      </CardHeader>
      <CardBody className="space-y-3">
        {form && (
          <form onSubmit={save} className="grid gap-2 md:grid-cols-5" aria-label="منطقة التوصيل">
            <Input aria-label="اسم المنطقة" placeholder="اسم المنطقة" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={80} />
            <Input aria-label="رسوم التوصيل للعميل" placeholder="رسوم العميل" dir="ltr" inputMode="decimal" value={form.fee} onChange={(e) => setForm({ ...form, fee: e.target.value })} />
            <Input aria-label="أجر المندوب" placeholder="أجر المندوب" dir="ltr" inputMode="decimal" value={form.driverFee} onChange={(e) => setForm({ ...form, driverFee: e.target.value })} />
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} /> فعّالة</label>
            <div className="flex gap-1"><Button type="submit" size="sm" disabled={pending}>حفظ</Button><Button type="button" size="sm" variant="ghost" onClick={() => setForm(null)}>إلغاء</Button></div>
          </form>
        )}
        {zones.length === 0 ? <p className="text-sm text-muted">لا توجد مناطق. أضف منطقة لتحديد رسوم التوصيل وأجر المندوب.</p> : (
          <table className="w-full text-sm">
            <thead className="text-xs text-muted"><tr><th className="p-2 text-start">المنطقة</th><th className="p-2 text-end">رسوم العميل</th><th className="p-2 text-end">أجر المندوب</th><th className="p-2" /></tr></thead>
            <tbody className="divide-y divide-line">
              {zones.map((z) => (
                <tr key={z.id} className={cn(!z.isActive && 'opacity-60')}>
                  <td className="p-2">{z.name}</td><td className="lb-numeric p-2">{money(z.feeCents)}</td><td className="lb-numeric p-2">{money(z.driverFeeCents)}</td>
                  <td className="p-2 text-end">{canManage && <Button size="sm" variant="ghost" onClick={() => setForm({ id: z.id, name: z.name, fee: fromCents(z.feeCents), driverFee: fromCents(z.driverFeeCents), isActive: z.isActive })}>تعديل</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardBody>
    </Card>
  );
}
