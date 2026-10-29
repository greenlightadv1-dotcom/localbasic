'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Bell, BellOff, Bike, CircleDot, Clock, ConciergeBell, Plus, Receipt, Scissors, Send,
  ShoppingBag, Sparkles, Users, UtensilsCrossed, Wallet, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/patterns/states';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { formatMoney } from '@/lib/money';
import { useLiveOrders } from '@/lib/realtime/use-live-orders';
import { useLiveRows } from '@/lib/realtime/use-live-rows';
import type { FloorPlan, FloorPlanTable, CheckLine } from '@/modules/restaurant/floor/service';
import type { CashierOrder } from '@/modules/restaurant/orders/service';
import { HUB_TABLE_STATUS } from '@/modules/restaurant/hub/schemas';
import { setOrderStatusAction, setTableStatusAction } from '../restaurant-actions';
import { checkLinesAction } from '../floor/actions';
import { SplitDialog } from '../floor/split-dialog';
import { OrderComposer, type ComposerTarget } from './order-composer';
import { CheckoutModal, type CheckoutOrder } from './checkout-modal';
import {
  ORDER_STATUS_AR, ORDER_TYPE_AR, minutesSince, tone,
  type PosCan, type PosMenuItem, type PosModifierGroup, type Scope,
} from './shared';

type Lane = 'floor' | 'takeaway' | 'delivery';
type Selection = { kind: 'table'; id: string } | { kind: 'order'; id: string } | null;
const STATUS_ORDER = ['available', 'occupied', 'reserved', 'waiting_payment', 'cleaning'] as const;
const PREP_AR: Record<string, { label: string; cls: string }> = {
  queued: { label: 'بالانتظار', cls: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200' },
  preparing: { label: 'يُحضَّر', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-100' },
  ready: { label: 'جاهز', cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-100' },
};

/**
 * Tables and point of sale. The floor as a grid of live tables — available,
 * occupied, reserved, at the bill (waiting_payment) or being cleaned — next
 * to the takeaway and delivery queues, with the selected check's lines, a new
 * round, fast checkout and split-bill one tap away.
 *
 * Live without a reload: order changes through useLiveOrders (Realtime with a
 * 5-second poll behind it), table status changes from another device through
 * useLiveRows. A refresh keeps the selection, an open composer and a typed
 * amount exactly as they were.
 */
export function PosFloor({
  scope, basePath, branchId, currency, plan, openOrders, menu, modifierGroups, can,
}: {
  scope: Scope; basePath: string; branchId: string; currency: string; plan: FloorPlan;
  openOrders: CashierOrder[]; menu: PosMenuItem[]; modifierGroups: PosModifierGroup[]; can: PosCan;
}) {
  const router = useRouter();
  const toast = useToast();
  const [lane, setLane] = useState<Lane>('floor');
  const [section, setSection] = useState<string>('all');
  const [status, setStatus] = useState<string>('all');
  const [selected, setSelected] = useState<Selection>(null);
  const [composer, setComposer] = useState<ComposerTarget | null>(null);
  const [checkout, setCheckout] = useState<CheckoutOrder | null>(null);
  const [splitting, setSplitting] = useState<{ id: string; number: string } | null>(null);
  const [sound, setSound] = useState(true);
  const [, setTick] = useState(0);

  useLiveOrders(branchId, 'hub-pos');
  useLiveRows(`hub-pos-${branchId}`, [{ table: 'restaurant_tables', filter: `branch_id=eq.${branchId}` }]);
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);

  const soundKey = `lb-hub-pos-sound-${branchId}`;
  useEffect(() => { try { setSound(window.localStorage.getItem(soundKey) !== 'off'); } catch { /* default on */ } }, [soundKey]);
  function toggleSound() {
    setSound((s) => { try { window.localStorage.setItem(soundKey, s ? 'off' : 'on'); } catch { /* ignore */ } return !s; });
  }

  const byId = useMemo(() => new Map(openOrders.map((o) => [o.id, o])), [openOrders]);
  const tableById = useMemo(() => new Map(plan.tables.map((t) => [t.id, t])), [plan.tables]);
  const takeaway = openOrders.filter((o) => o.type === 'takeaway');
  const delivery = openOrders.filter((o) => o.type === 'delivery');

  // An order turning ready is the waiter's cue: a tone and a toast, once.
  const lastStatus = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    const prev = lastStatus.current;
    const next = new Map(openOrders.map((o) => [o.id, o.status]));
    if (prev) {
      for (const o of openOrders) {
        if (o.status === 'ready' && prev.get(o.id) && prev.get(o.id) !== 'ready') {
          if (sound) tone('ready');
          toast.success(`جاهز للتقديم: ${o.tableName ? `طاولة ${o.tableName}` : ORDER_TYPE_AR[o.type] ?? ''} — #${o.number}`);
        }
      }
    }
    lastStatus.current = next;
  }, [openOrders, sound, toast]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of plan.tables) c[t.status] = (c[t.status] ?? 0) + 1;
    return c;
  }, [plan.tables]);

  const tables = plan.tables
    .filter((t) => section === 'all' || t.sectionId === section)
    .filter((t) => status === 'all' || t.status === status)
    .sort((a, b) => a.name.localeCompare(b.name, 'ar', { numeric: true }));
  const sectionName = new Map(plan.sections.map((s) => [s.id, s.name]));

  function doneComposing(orderId: string | null) {
    setComposer(null);
    if (orderId && selected?.kind !== 'table') setSelected({ kind: 'order', id: orderId });
    router.refresh();
  }

  function openCheckout(orderId: string, label: string) {
    const o = byId.get(orderId);
    if (!o) return;
    setCheckout({ id: o.id, number: o.number, status: o.status, totalCents: o.totalCents, paidCents: o.paidCents, label });
  }

  const selectedTable = selected?.kind === 'table' ? tableById.get(selected.id) ?? null : null;
  const selectedOrder = selected?.kind === 'order' ? byId.get(selected.id) ?? null : null;

  return (
    <div className="space-y-4" data-testid="pos-floor">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded border border-line p-0.5" role="tablist" aria-label="نوع الخدمة">
          {([
            ['floor', 'الصالة', UtensilsCrossed, plan.tables.length],
            ['takeaway', 'تيك أواي', ShoppingBag, takeaway.length],
            ['delivery', 'دليفري', Bike, delivery.length],
          ] as const).map(([k, label, Icon, n]) => (
            <button key={k} type="button" role="tab" aria-selected={lane === k} onClick={() => setLane(k)}
              className={cn('inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-semibold',
                lane === k ? 'bg-primary text-primary-fg' : 'text-muted hover:text-fg')} data-testid={`lane-${k}`}>
              <Icon className="h-4 w-4" aria-hidden="true" /> {label}
              <span className="lb-numeric text-xs opacity-80">{n}</span>
            </button>
          ))}
        </div>
        <div className="ms-auto flex items-center gap-2">
          {lane === 'takeaway' && can.order && (
            <Button size="sm" onClick={() => setComposer({ mode: 'new', type: 'takeaway' })} data-testid="new-takeaway">
              <Plus className="h-4 w-4" aria-hidden="true" /> طلب تيك أواي
            </Button>
          )}
          {lane === 'delivery' && can.delivery && (
            <Link href={`${basePath}/call-center`} className="inline-flex h-9 items-center gap-1.5 rounded bg-primary px-3 text-sm font-semibold text-primary-fg">
              <Plus className="h-4 w-4" aria-hidden="true" /> طلب دليفري (الكول سنتر)
            </Link>
          )}
          <Button size="icon" variant="ghost" onClick={toggleSound} aria-pressed={sound}
            aria-label={sound ? 'كتم تنبيه الطلبات الجاهزة' : 'تشغيل تنبيه الطلبات الجاهزة'}>
            {sound ? <Bell className="h-4 w-4" aria-hidden="true" /> : <BellOff className="h-4 w-4" aria-hidden="true" />}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <section aria-label="الطاولات والطلبات" className="min-w-0 space-y-3">
          {lane === 'floor' ? (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                <button type="button" onClick={() => setStatus('all')}
                  className={cn('rounded-full border px-3 py-1 text-xs font-semibold', status === 'all' ? 'border-fg bg-fg text-surface' : 'border-line text-muted')}>
                  الكل <span className="lb-numeric">{plan.tables.length}</span>
                </button>
                {STATUS_ORDER.map((s) => (
                  <button key={s} type="button" onClick={() => setStatus(status === s ? 'all' : s)} aria-pressed={status === s}
                    className={cn('inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold',
                      status === s ? HUB_TABLE_STATUS[s]!.tone : 'border-line text-muted')} data-testid={`status-filter-${s}`}>
                    <span className={cn('h-2 w-2 rounded-full', HUB_TABLE_STATUS[s]!.dot)} aria-hidden="true" />
                    {HUB_TABLE_STATUS[s]!.label} <span className="lb-numeric">{counts[s] ?? 0}</span>
                  </button>
                ))}
                {plan.sections.length > 1 && (
                  <select value={section} onChange={(e) => setSection(e.target.value)} aria-label="المنطقة"
                    className="ms-auto h-8 rounded border border-line bg-elevated px-2 text-xs">
                    <option value="all">كل المناطق</option>
                    {plan.sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                )}
              </div>

              {plan.tables.length === 0 ? (
                <EmptyState icon={UtensilsCrossed} title="لا توجد طاولات بعد"
                  description="أضف طاولات الفرع من شاشة الطاولات لتظهر هنا."
                  action={{ label: 'إدارة الطاولات', href: `${basePath}/tables` }} />
              ) : tables.length === 0 ? (
                <p className="rounded border border-dashed border-line p-6 text-center text-sm text-muted">لا توجد طاولات بهذه الحالة.</p>
              ) : (
                <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4" data-testid="table-grid">
                  {tables.map((t) => (
                    <li key={t.id}>
                      <TableCard table={t} currency={currency} holder={t.mergedInto ? tableById.get(t.mergedInto) ?? null : null}
                        section={plan.sections.length > 1 && t.sectionId ? sectionName.get(t.sectionId) ?? null : null}
                        selected={selected?.kind === 'table' && selected.id === t.id}
                        onSelect={() => setSelected({ kind: 'table', id: t.id })} />
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <OffFloorQueue orders={lane === 'takeaway' ? takeaway : delivery} lane={lane} currency={currency}
              selectedId={selected?.kind === 'order' ? selected.id : null}
              onSelect={(id) => setSelected({ kind: 'order', id })} />
          )}
        </section>

        <aside aria-label="تفاصيل الطلب" className="lg:sticky lg:top-4 lg:self-start">
          {selectedTable ? (
            <TableDetail scope={scope} basePath={basePath} currency={currency} table={selectedTable}
              holder={selectedTable.mergedInto ? tableById.get(selectedTable.mergedInto) ?? selectedTable : selectedTable}
              byId={byId} can={can} onClose={() => setSelected(null)}
              onNewOrder={(t) => setComposer({ mode: 'new', type: 'dine_in', tableId: t.id, tableName: t.name })}
              onAdd={(o, label) => setComposer({ mode: 'add', orderId: o.id, orderNumber: o.number, label })}
              onCheckout={openCheckout} onSplit={(o) => setSplitting(o)} />
          ) : selectedOrder ? (
            <div className="space-y-2 rounded-lg border border-line bg-elevated p-3">
              <div className="flex items-center justify-between">
                <h2 className="font-bold">{ORDER_TYPE_AR[selectedOrder.type] ?? selectedOrder.type}{selectedOrder.guestName ? ` — ${selectedOrder.guestName}` : ''}</h2>
                <button type="button" onClick={() => setSelected(null)} className="p-1 text-muted hover:text-fg" aria-label="إغلاق"><X className="h-4 w-4" aria-hidden="true" /></button>
              </div>
              {selectedOrder.delivery && (
                <p className="text-xs text-muted">{selectedOrder.delivery.recipientName} · <bdi dir="ltr">{selectedOrder.delivery.phone}</bdi> · {selectedOrder.delivery.address}</p>
              )}
              <OrderCard scope={scope} currency={currency} order={selectedOrder} can={can} splittable={false}
                onAdd={() => setComposer({ mode: 'add', orderId: selectedOrder.id, orderNumber: selectedOrder.number, label: `#${selectedOrder.number}` })}
                onCheckout={() => openCheckout(selectedOrder.id, `${ORDER_TYPE_AR[selectedOrder.type] ?? ''} #${selectedOrder.number}`)}
                onSplit={() => undefined} />
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-muted">
              <CircleDot className="mx-auto mb-2 h-6 w-6" aria-hidden="true" />
              اختر طاولة أو طلبًا لعرض تفاصيله وأخذ الطلبات والتحصيل.
            </div>
          )}
        </aside>
      </div>

      {composer && (
        <OrderComposer scope={scope} currency={currency} menu={menu} groups={modifierGroups} target={composer}
          onClose={() => setComposer(null)} onDone={doneComposing} />
      )}
      {checkout && (
        <CheckoutModal scope={scope} currency={currency} order={checkout} canDiscount={can.discount}
          onClose={() => { setCheckout(null); router.refresh(); }}
          onPaid={() => router.refresh()} />
      )}
      {splitting && (
        <SplitDialog scope={scope} currency={currency} orderId={splitting.id} orderNumber={splitting.number}
          onClose={() => { setSplitting(null); router.refresh(); }} />
      )}
    </div>
  );
}

function TableCard({ table, holder, section, currency, selected, onSelect }: {
  table: FloorPlanTable; holder: FloorPlanTable | null; section: string | null; currency: string;
  selected: boolean; onSelect: () => void;
}) {
  const source = holder ?? table;
  const st = HUB_TABLE_STATUS[source.status] ?? HUB_TABLE_STATUS.available!;
  const total = source.orders.reduce((s, o) => s + o.totalCents, 0);
  const oldest = source.orders.reduce<string | null>((m, o) => (!m || o.placedAt < m ? o.placedAt : m), null);
  const ready = source.orders.some((o) => o.status === 'ready');
  const unsent = source.orders.some((o) => o.status === 'new');
  return (
    <button type="button" onClick={onSelect} aria-pressed={selected}
      className={cn('relative flex h-full min-h-[6.5rem] w-full flex-col justify-between rounded-lg border-2 p-3 text-start transition',
        st.tone, selected && 'ring-2 ring-primary ring-offset-2 ring-offset-surface', ready && 'animate-pulse')}
      data-testid={`table-${table.name}`} data-status={source.status}>
      <div className="flex items-start justify-between gap-1">
        <span className="text-lg font-black leading-none"><bdi>{table.name}</bdi></span>
        <span className="text-[11px] font-semibold">{st.label}</span>
      </div>
      <div className="mt-2 space-y-0.5 text-xs">
        <p className="flex items-center gap-1 opacity-80"><Users className="h-3 w-3" aria-hidden="true" /> {table.seats}{section ? ` · ${section}` : ''}</p>
        {holder && <p className="opacity-80">مع <bdi>{holder.name}</bdi></p>}
        {table.heldFor && !holder && <p className="truncate opacity-80">لـ {table.heldFor}</p>}
        {source.orders.length > 0 && !holder && (
          <p className="flex items-center justify-between gap-1 font-semibold">
            <span className="flex items-center gap-1 lb-numeric"><Clock className="h-3 w-3" aria-hidden="true" />{oldest ? minutesSince(oldest) : 0}د</span>
            <span className="lb-numeric">{formatMoney(total, currency)}</span>
          </p>
        )}
      </div>
      {(ready || unsent) && !holder && (
        <span className={cn('absolute -top-2 end-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold text-white', ready ? 'bg-emerald-600' : 'bg-rose-600')}>
          {ready ? <><ConciergeBell className="h-3 w-3" aria-hidden="true" /> جاهز</> : 'لم يُرسل'}
        </span>
      )}
    </button>
  );
}

function OffFloorQueue({ orders, lane, currency, selectedId, onSelect }: {
  orders: CashierOrder[]; lane: Lane; currency: string; selectedId: string | null; onSelect: (id: string) => void;
}) {
  if (orders.length === 0) {
    return <EmptyState icon={lane === 'takeaway' ? ShoppingBag : Bike} title={lane === 'takeaway' ? 'لا طلبات تيك أواي مفتوحة' : 'لا طلبات دليفري مفتوحة'} description="الطلبات الجديدة تظهر هنا لحظيًا." />;
  }
  return (
    <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" data-testid={`queue-${lane}`}>
      {orders.map((o) => (
        <li key={o.id}>
          <button type="button" onClick={() => onSelect(o.id)} aria-pressed={selectedId === o.id}
            className={cn('w-full rounded-lg border-2 bg-elevated p-3 text-start', selectedId === o.id ? 'border-primary' : 'border-line',
              o.status === 'ready' && 'border-emerald-500')}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-bold lb-numeric">#{o.number}</span>
              <Badge tone={o.status === 'ready' ? 'success' : o.status === 'new' ? 'warn' : 'info'}>{ORDER_STATUS_AR[o.status] ?? o.status}</Badge>
            </div>
            <p className="mt-1 truncate text-sm">{o.guestName ?? o.delivery?.recipientName ?? '—'}</p>
            <div className="mt-1 flex items-center justify-between text-xs text-muted">
              <span className="lb-numeric">{o.itemCount} صنف · {minutesSince(o.placedAt)} دقيقة</span>
              <span className="font-semibold text-fg lb-numeric">{formatMoney(o.totalCents, currency)}</span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function TableDetail({
  scope, basePath, currency, table, holder, byId, can, onClose, onNewOrder, onAdd, onCheckout, onSplit,
}: {
  scope: Scope; basePath: string; currency: string; table: FloorPlanTable; holder: FloorPlanTable;
  byId: Map<string, CashierOrder>; can: PosCan; onClose: () => void;
  onNewOrder: (t: FloorPlanTable) => void; onAdd: (o: CashierOrder, label: string) => void;
  onCheckout: (orderId: string, label: string) => void; onSplit: (o: { id: string; number: string }) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const st = HUB_TABLE_STATUS[holder.status] ?? HUB_TABLE_STATUS.available!;
  const orders = holder.orders.map((o) => byId.get(o.id)).filter((o): o is CashierOrder => Boolean(o));
  const total = orders.reduce((s, o) => s + o.totalCents, 0);
  const paid = orders.reduce((s, o) => s + o.paidCents, 0);

  function setStatus(next: 'available' | 'reserved' | 'waiting_payment' | 'occupied', ok: string) {
    start(async () => {
      const r = await setTableStatusAction(scope, { tableId: holder.id, status: next });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success(ok);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3 rounded-lg border border-line bg-elevated p-3" data-testid="table-detail">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-black">
            طاولة <bdi>{table.name}</bdi>
            <span className={cn('rounded border-2 px-2 py-0.5 text-xs font-semibold', st.tone)}>{st.label}</span>
          </h2>
          <p className="text-xs text-muted">
            {table.seats} مقاعد{holder.id !== table.id && <> · مدموجة مع <bdi>{holder.name}</bdi></>}{holder.heldFor && <> · محجوزة لـ {holder.heldFor}</>}
          </p>
        </div>
        <button type="button" onClick={onClose} className="p-1 text-muted hover:text-fg" aria-label="إغلاق"><X className="h-4 w-4" aria-hidden="true" /></button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {can.order && holder.status !== 'cleaning' && (
          <Button size="sm" onClick={() => onNewOrder(holder)} disabled={pending} data-testid="table-new-order">
            <Plus className="h-4 w-4" aria-hidden="true" /> {orders.length ? 'طلب منفصل' : 'فتح طلب'}
          </Button>
        )}
        {can.setStatus && holder.status === 'occupied' && orders.length > 0 && (
          <Button size="sm" variant="outline" onClick={() => setStatus('waiting_payment', 'الطاولة تطلب الحساب')} disabled={pending}>
            <Receipt className="h-4 w-4" aria-hidden="true" /> طلب الحساب
          </Button>
        )}
        {can.setStatus && holder.status === 'waiting_payment' && (
          <Button size="sm" variant="ghost" onClick={() => setStatus('occupied', 'رجعت الطاولة للخدمة')} disabled={pending}>إلغاء طلب الحساب</Button>
        )}
        {can.setStatus && holder.status === 'cleaning' && (
          <Button size="sm" variant="outline" onClick={() => setStatus('available', 'الطاولة جاهزة')} disabled={pending}>
            <Sparkles className="h-4 w-4" aria-hidden="true" /> تم التنظيف
          </Button>
        )}
        {can.setStatus && holder.status === 'available' && (
          <Button size="sm" variant="ghost" onClick={() => setStatus('reserved', 'تم حجز الطاولة')} disabled={pending}>حجز</Button>
        )}
        {can.setStatus && holder.status === 'reserved' && !holder.heldFor && (
          <Button size="sm" variant="ghost" onClick={() => setStatus('available', 'أُلغي الحجز')} disabled={pending}>إلغاء الحجز</Button>
        )}
        <Link href={`${basePath}/floor`} className="inline-flex h-8 items-center px-2 text-xs font-semibold text-primary">نقل / دمج ←</Link>
      </div>

      {orders.length === 0 ? (
        <p className="rounded border border-dashed border-line p-4 text-center text-sm text-muted">لا توجد طلبات مفتوحة على الطاولة.</p>
      ) : (
        <>
          <ul className="space-y-2">
            {orders.map((o) => (
              <li key={o.id}>
                <OrderCard scope={scope} currency={currency} order={o} can={can} splittable
                  onAdd={() => onAdd(o, `طاولة ${holder.name} #${o.number}`)}
                  onCheckout={() => onCheckout(o.id, `طاولة ${holder.name}`)}
                  onSplit={() => onSplit({ id: o.id, number: o.number })} />
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between border-t border-line pt-2 text-sm">
            <span className="text-muted">إجمالي الطاولة{paid > 0 && ` · مدفوع ${formatMoney(paid, currency)}`}</span>
            <span className="text-lg font-black lb-numeric">{formatMoney(total, currency)}</span>
          </div>
        </>
      )}
    </div>
  );
}

function OrderCard({ scope, currency, order, can, splittable, onAdd, onCheckout, onSplit }: {
  scope: Scope; currency: string; order: CashierOrder; can: PosCan; splittable: boolean;
  onAdd: () => void; onCheckout: () => void; onSplit: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [lines, setLines] = useState<CheckLine[] | null>(null);
  const [failed, setFailed] = useState(false);
  const version = `${order.id}:${order.totalCents}:${order.status}:${order.itemCount}`;

  useEffect(() => {
    let live = true;
    void checkLinesAction(scope, { orderId: order.id }).then((r) => {
      if (!live) return;
      if (r.ok) { setLines(r.data); setFailed(false); } else setFailed(true);
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  function move(status: 'confirmed' | 'served', ok: string) {
    start(async () => {
      const r = await setOrderStatusAction(scope, { orderId: order.id, status });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success(ok);
      router.refresh();
    });
  }

  const due = Math.max(0, order.totalCents - order.paidCents);
  const open = !order.invoiceId;

  return (
    <article className="rounded border border-line p-2.5" data-testid={`order-${order.number}`}>
      <header className="flex items-center justify-between gap-2">
        <span className="font-bold lb-numeric">#{order.number}</span>
        <span className="flex items-center gap-1.5">
          <span className="text-xs text-muted lb-numeric">{minutesSince(order.placedAt)}د</span>
          <Badge tone={order.status === 'ready' ? 'success' : order.status === 'new' ? 'warn' : order.status === 'served' ? 'neutral' : 'info'}>
            {ORDER_STATUS_AR[order.status] ?? order.status}
          </Badge>
        </span>
      </header>

      {lines === null ? (
        <p className="py-2 text-xs text-muted">{failed ? 'تعذّر تحميل الأصناف.' : 'جارٍ التحميل…'}</p>
      ) : (
        <ul className="mt-2 divide-y divide-line text-sm">
          {lines.map((l) => (
            <li key={l.id} className="flex items-start justify-between gap-2 py-1.5">
              <div className="min-w-0">
                <p className="leading-tight"><span className="font-bold text-primary lb-numeric">{l.quantity}×</span> <bdi>{l.productName}</bdi>
                  {l.variantName !== 'default' && <span className="text-muted"> — {l.variantName}</span>}</p>
                {l.modifiers.length > 0 && <p className="text-xs text-muted">{l.modifiers.join('، ')}</p>}
              </div>
              <span className="flex shrink-0 flex-col items-end gap-0.5">
                <span className="text-xs lb-numeric">{formatMoney(l.lineTotalCents, currency)}</span>
                {order.status !== 'new' && PREP_AR[l.prepStatus] && (
                  <span className={cn('rounded px-1.5 text-[10px] font-semibold', PREP_AR[l.prepStatus]!.cls)}>{PREP_AR[l.prepStatus]!.label}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex items-center justify-between text-sm">
        <span className="text-muted">{order.paidCents > 0 ? `المتبقي` : 'الإجمالي'}</span>
        <span className="font-bold lb-numeric">{formatMoney(order.paidCents > 0 ? due : order.totalCents, currency)}</span>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {can.order && open && (
          <Button size="sm" variant="outline" onClick={onAdd} disabled={pending} data-testid="order-add-items">
            <Plus className="h-3.5 w-3.5" aria-hidden="true" /> إضافة
          </Button>
        )}
        {order.status === 'new' && (
          <Button size="sm" onClick={() => move('confirmed', 'أُرسل الطلب للمطبخ')} disabled={pending} data-testid="order-send">
            <Send className="h-3.5 w-3.5" aria-hidden="true" /> للمطبخ
          </Button>
        )}
        {order.status === 'ready' && can.serve && (
          <Button size="sm" variant="outline" onClick={() => move('served', 'تم التقديم')} disabled={pending} data-testid="order-serve">
            <ConciergeBell className="h-3.5 w-3.5" aria-hidden="true" /> تم التقديم
          </Button>
        )}
        {splittable && can.split && open && (lines?.length ?? 0) > 0 && (
          <Button size="sm" variant="ghost" onClick={onSplit} disabled={pending} data-testid="order-split">
            <Scissors className="h-3.5 w-3.5" aria-hidden="true" /> تقسيم
          </Button>
        )}
        {can.pay && due > 0 && (
          <Button size="sm" className="ms-auto" onClick={onCheckout} disabled={pending} data-testid="order-checkout">
            <Wallet className="h-3.5 w-3.5" aria-hidden="true" /> تحصيل
          </Button>
        )}
      </div>
    </article>
  );
}
