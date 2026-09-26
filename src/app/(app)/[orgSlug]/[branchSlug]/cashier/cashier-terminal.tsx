'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Minus, Trash2, Search, ReceiptText, X, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/ui/confirm';
import { useToast } from '@/components/ui/toast';
import { EmptyState } from '@/components/patterns/states';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/cn';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import type { MenuItem } from '@/modules/restaurant/menu/service';
import type { FloorTable } from '@/modules/restaurant/tables/service';
import type { CashierOrder } from '@/modules/restaurant/orders/service';
import { STATUS_LABELS, STATUS_TONES } from '@/modules/restaurant/orders/schemas';
import { createOrderAction, payOrderAction, setOrderStatusAction } from '../restaurant-actions';

const CHANNEL_LABELS: Record<string, string> = {
  qr: 'رمز QR', waiter: 'الكابتن', cashier: 'الكاشير', online: 'أونلاين',
};
const TYPE_LABELS: Record<string, string> = {
  dine_in: 'صالة', takeaway: 'سفري', pickup: 'استلام', delivery: 'توصيل',
};

type ModifierGroup = {
  id: string;
  productId: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  modifiers: { id: string; name: string; priceCents: number }[];
};

type CartLine = {
  key: string;
  item: MenuItem;
  variantId: string;
  variantName: string;
  unitPriceCents: number;
  quantity: number;
  modifiers: { id: string; name: string; priceCents: number }[];
};

/**
 * The till.
 *
 * Two jobs on one screen: take a new order, and settle an open one. Totals
 * shown while building a cart are a preview computed with the same integer
 * arithmetic the server uses — the figures that matter come back from
 * restaurant_create_order and restaurant_pay_order, which price everything
 * from the database.
 */
export function CashierTerminal({
  menu,
  modifierGroups,
  floor,
  openOrders,
  currency,
  canDiscount,
  canCancel,
  branchId,
  organizationSlug,
  branchSlug,
}: {
  menu: MenuItem[];
  modifierGroups: ModifierGroup[];
  floor: FloorTable[];
  openOrders: CashierOrder[];
  currency: string;
  canDiscount: boolean;
  canCancel: boolean;
  branchId: string;
  organizationSlug: string;
  branchSlug: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [isPending, startTransition] = useTransition();

  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [tableId, setTableId] = useState<string>('');
  const [orderType, setOrderType] = useState<'dine_in' | 'takeaway'>('dine_in');
  const [error, setError] = useState<string | null>(null);

  // Modifier picker for an item that requires choices.
  const [picking, setPicking] = useState<{ item: MenuItem; variantId: string } | null>(null);
  const [chosen, setChosen] = useState<Record<string, string[]>>({});

  // Settling an existing order.
  const [settling, setSettling] = useState<CashierOrder | null>(null);
  const [tendered, setTendered] = useState('');
  const [discount, setDiscount] = useState('');
  const [method, setMethod] = useState('cash');
  const [receipt, setReceipt] = useState<{
    number: string;
    total: number;
    paid: number;
    due: number;
    change: number;
  } | null>(null);
  const [cancelling, setCancelling] = useState<CashierOrder | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);

  // New orders (an online guest, a QR table, another till) and status
  // changes both land on this branch's restaurant_orders rows. Realtime
  // delivers a change here only when this session's own RLS (orders_select,
  // 0020) would let it read that row directly — the same guarantee
  // MembershipWatch already relies on — so subscribing needs no new broadcast
  // trigger, just the table added to the publication (0073).
  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    const channel = supabase
      .channel(`cashier-orders:${branchId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'restaurant_orders',
          filter: `branch_id=eq.${branchId}`,
        },
        () => router.refresh(),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [branchId, router]);

  const results = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return menu;
    return menu.filter(
      (m) =>
        m.name.toLowerCase().includes(term) ||
        (m.categoryName ?? '').toLowerCase().includes(term),
    );
  }, [menu, search]);

  const cartTotal = useMemo(
    () =>
      cart.reduce((sum, line) => {
        const unit = line.unitPriceCents + line.modifiers.reduce((s, m) => s + m.priceCents, 0);
        const gross = Math.round(unit * line.quantity);
        const item = line.item;
        return sum + gross + Math.round((gross * item.taxRateBp) / 10_000);
      }, 0),
    [cart],
  );

  function groupsFor(productId: string) {
    return modifierGroups.filter((g) => g.productId === productId);
  }

  function beginAdd(item: MenuItem, variantId: string) {
    const groups = groupsFor(item.id);
    if (groups.length === 0) {
      addLine(item, variantId, []);
      return;
    }
    setChosen({});
    setPicking({ item, variantId });
  }

  function addLine(
    item: MenuItem,
    variantId: string,
    modifiers: { id: string; name: string; priceCents: number }[],
  ) {
    const variant = item.variants.find((v) => v.id === variantId);
    if (!variant) return;
    const key = `${variantId}:${modifiers.map((m) => m.id).sort().join(',')}`;

    setCart((lines) => {
      const existing = lines.find((l) => l.key === key);
      if (existing) {
        return lines.map((l) => (l.key === key ? { ...l, quantity: l.quantity + 1 } : l));
      }
      return [
        ...lines,
        {
          key,
          item,
          variantId,
          variantName: variant.name,
          unitPriceCents: variant.priceCents,
          quantity: 1,
          modifiers,
        },
      ];
    });
    setError(null);
  }

  function confirmModifiers() {
    if (!picking) return;
    const groups = groupsFor(picking.item.id);

    for (const group of groups) {
      const picked = chosen[group.id] ?? [];
      if (picked.length < group.minSelect || picked.length > group.maxSelect) {
        setError(`اختر من ${group.minSelect} إلى ${group.maxSelect} من «${group.name}»`);
        return;
      }
    }

    const modifiers = groups.flatMap((g) =>
      (chosen[g.id] ?? []).map((id) => {
        const m = g.modifiers.find((x) => x.id === id)!;
        return { id: m.id, name: m.name, priceCents: m.priceCents };
      }),
    );

    addLine(picking.item, picking.variantId, modifiers);
    setPicking(null);
  }

  function submitOrder() {
    if (cart.length === 0) return;
    setError(null);

    startTransition(async () => {
      const result = await createOrderAction(
        { organizationSlug, branchSlug },
        {
          items: cart.map((l) => ({
            variantId: l.variantId,
            quantity: l.quantity,
            modifierIds: l.modifiers.map((m) => m.id),
          })),
          tableId: orderType === 'dine_in' && tableId ? tableId : null,
          type: orderType,
        },
      );

      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(`تم إنشاء الطلب #${result.data.number}`);
      setCart([]);
      setTableId('');
      router.refresh();
    });
  }

  function confirmOrder(order: CashierOrder) {
    startTransition(async () => {
      const result = await setOrderStatusAction(
        { organizationSlug, branchSlug },
        { orderId: order.id, status: 'confirmed' },
      );
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success('تم تأكيد الطلب وإرساله للمطبخ');
      router.refresh();
    });
  }

  function parseAmount(text: string): number {
    const clean = text.trim().replace(/[,\s]/g, '');
    if (!/^\d*(\.\d{0,2})?$/.test(clean) || clean === '') return 0;
    const [whole = '0', fraction = ''] = clean.split('.');
    return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  }

  function settle() {
    if (!settling) return;
    startTransition(async () => {
      const result = await payOrderAction(
        { organizationSlug, branchSlug },
        {
          orderId: settling.id,
          method,
          tenderedCents: parseAmount(tendered) || settling.totalCents,
          discountCents: canDiscount ? parseAmount(discount) : 0,
        },
      );

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      setReceipt({
        number: result.data.receiptNumber,
        total: result.data.totalCents,
        paid: result.data.paidCents,
        due: result.data.dueCents,
        change: result.data.changeCents,
      });

      // A fully settled order is closed out; a partial payment leaves it open.
      if (result.data.dueCents === 0 && settling.status === 'served') {
        await setOrderStatusAction(
          { organizationSlug, branchSlug },
          { orderId: settling.id, status: 'completed' },
        );
      }

      setSettling(null);
      setTendered('');
      setDiscount('');
      router.refresh();
    });
  }

  function cancelOrder() {
    if (!cancelling || !cancelReason.trim()) return;
    startTransition(async () => {
      const result = await setOrderStatusAction(
        { organizationSlug, branchSlug },
        { orderId: cancelling.id, status: 'cancelled', reason: cancelReason.trim() },
      );
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success('تم إلغاء الطلب');
      setCancelling(null);
      setCancelReason('');
      router.refresh();
    });
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
      {/* Menu + open orders */}
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}

        <Card>
          <CardHeader className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>الطلبات المفتوحة</CardTitle>
            <Badge tone={openOrders.length ? 'info' : 'neutral'}>{openOrders.length}</Badge>
          </CardHeader>
          <CardBody className="p-0">
            {openOrders.length === 0 ? (
              <p className="p-5 text-center text-sm text-muted">لا توجد طلبات مفتوحة.</p>
            ) : (
              <ul className="divide-y divide-line">
                {openOrders.map((order) => {
                  const expanded = expandedOrderId === order.id;
                  return (
                  <li key={order.id} className="p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setExpandedOrderId(expanded ? null : order.id)}
                        className="flex min-w-0 flex-1 items-start gap-2 text-start"
                      >
                        <ChevronDown
                          className={cn('mt-1 h-4 w-4 shrink-0 text-muted transition-transform', expanded && 'rotate-180')}
                          aria-hidden="true"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold">
                            {order.tableName ? <>طاولة <bdi>{order.tableName}</bdi></> : TYPE_LABELS[order.type] ?? order.type}
                            <span className="lb-numeric ms-2 text-sm text-muted">#{order.number}</span>
                            <Badge tone={order.channel === 'online' ? 'info' : 'neutral'} className="ms-2">
                              {CHANNEL_LABELS[order.channel] ?? order.channel}
                            </Badge>
                          </p>
                          <p className="lb-numeric text-sm text-muted">
                            {formatMoney(order.totalCents, currency)}
                            {order.paidCents > 0 && order.paidCents < order.totalCents && (
                              <span className="text-warn">
                                {' '}
                                · مدفوع {formatMoney(order.paidCents, currency)}
                              </span>
                            )}
                            {' · '}
                            {order.itemCount} صنف
                          </p>
                        </div>
                      </button>
                      <Badge tone={STATUS_TONES[order.status]}>{STATUS_LABELS[order.status]}</Badge>
                      {order.status === 'new' && (
                        <Button size="sm" disabled={isPending} onClick={() => confirmOrder(order)}>
                          تأكيد
                        </Button>
                      )}
                      {order.paidCents < order.totalCents && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={isPending}
                          onClick={() => {
                            setSettling(order);
                            setTendered('');
                            setDiscount('');
                          }}
                        >
                          تحصيل
                        </Button>
                      )}
                      {canCancel && order.paidCents === 0 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-danger"
                          onClick={() => setCancelling(order)}
                        >
                          إلغاء
                        </Button>
                      )}
                    </div>

                    {expanded && (
                      <div className="mt-3 space-y-3 rounded-lg border border-line bg-surface p-3 text-sm">
                        {order.guestName && (
                          <p>
                            <span className="text-muted">العميل: </span>
                            <span className="font-medium">{order.guestName}</span>
                            {order.guestPhone && (
                              <span className="lb-numeric text-muted"> — {order.guestPhone}</span>
                            )}
                          </p>
                        )}
                        {order.delivery && (
                          <div className="rounded border border-line bg-elevated p-2">
                            <p className="font-medium">
                              {order.delivery.recipientName}
                              <span className="lb-numeric text-muted"> — {order.delivery.phone}</span>
                            </p>
                            <p className="text-muted">
                              {order.delivery.address}
                              {(order.delivery.area || order.delivery.city) && (
                                <span> ({[order.delivery.area, order.delivery.city].filter(Boolean).join('، ')})</span>
                              )}
                            </p>
                            {order.delivery.landmark && (
                              <p className="text-xs text-muted">علامة مميزة: {order.delivery.landmark}</p>
                            )}
                            {order.delivery.notes && (
                              <p className="text-xs text-muted">ملاحظات التوصيل: {order.delivery.notes}</p>
                            )}
                          </div>
                        )}
                        <ul className="space-y-1.5">
                          {order.lines.map((line) => (
                            <li key={line.id}>
                              <p className="flex gap-2 font-medium">
                                <span className="lb-numeric shrink-0 text-primary">{line.quantity}×</span>
                                <span>
                                  <bdi>{line.productName}</bdi>
                                  {line.variantName !== 'default' && (
                                    <span className="text-muted"> — {line.variantName}</span>
                                  )}
                                </span>
                              </p>
                              {line.modifiers.length > 0 && (
                                <p className="ps-6 text-xs text-muted">
                                  {line.modifiers.map((m) => m.name).join('، ')}
                                </p>
                              )}
                              {line.note && (
                                <p className="ps-6 text-xs font-medium text-warn">{line.note}</p>
                              )}
                            </li>
                          ))}
                        </ul>
                        {order.note && (
                          <p className="rounded bg-warn/10 p-2 text-xs font-medium text-warn">
                            ملاحظة الطلب: {order.note}
                          </p>
                        )}
                      </div>
                    )}
                  </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>

        <div className="relative">
          <Search
            className="pointer-events-none absolute inset-y-0 start-3 my-auto h-5 w-5 text-muted"
            aria-hidden="true"
          />
          <label htmlFor="cashier-search" className="sr-only">
            ابحث في المنيو
          </label>
          <Input
            id="cashier-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="ابحث في المنيو…"
            className="h-12 ps-10"
            autoComplete="off"
          />
        </div>

        {results.length === 0 ? (
          <Card>
            <EmptyState
              icon={ReceiptText}
              title="لا توجد أصناف"
              description="أضف أصنافًا إلى المنيو أولًا."
            />
          </Card>
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 2xl:grid-cols-4">
            {results.flatMap((item) =>
              item.variants.map((variant) => (
                <li key={variant.id}>
                  <button
                    type="button"
                    disabled={!variant.isAvailableHere}
                    onClick={() => beginAdd(item, variant.id)}
                    className={cn(
                      'flex h-full w-full flex-col items-start gap-1 rounded border p-3 text-start transition-colors',
                      variant.isAvailableHere
                        ? 'border-line bg-elevated hover:border-primary hover:bg-primary-soft'
                        : 'cursor-not-allowed border-line bg-surface opacity-55',
                    )}
                  >
                    <span className="line-clamp-2 text-sm font-medium">{item.name}</span>
                    {variant.name !== 'default' && (
                      <span className="text-xs text-muted">{variant.name}</span>
                    )}
                    <span className="lb-numeric mt-auto font-bold text-primary">
                      {formatMoney(variant.priceCents, currency)}
                    </span>
                    {!variant.isAvailableHere && (
                      <span className="text-xs font-medium text-danger">غير متاح</span>
                    )}
                  </button>
                </li>
              )),
            )}
          </ul>
        )}
      </div>

      {/* Cart */}
      <aside
        className="flex flex-col gap-3 rounded-lg border border-line bg-elevated p-4 xl:sticky xl:top-20 xl:h-[calc(100dvh-6rem)]"
        aria-label="الطلب الجديد"
      >
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">طلب جديد</h2>
          {cart.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setCart([])}>
              <X className="h-4 w-4" aria-hidden="true" />
              إفراغ
            </Button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor="order-type" className="mb-1 block text-xs font-medium">
              نوع الطلب
            </label>
            <Select
              id="order-type"
              value={orderType}
              onChange={(e) => setOrderType(e.target.value as 'dine_in' | 'takeaway')}
              className="h-10"
            >
              <option value="dine_in">صالة</option>
              <option value="takeaway">سفري</option>
            </Select>
          </div>
          {orderType === 'dine_in' && (
            <div>
              <label htmlFor="order-table" className="mb-1 block text-xs font-medium">
                الطاولة
              </label>
              <Select
                id="order-table"
                value={tableId}
                onChange={(e) => setTableId(e.target.value)}
                className="h-10"
              >
                <option value="">بدون</option>
                {floor.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {cart.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted">اختر صنفًا للبدء.</p>
          ) : (
            <ul className="space-y-2">
              {cart.map((line) => (
                <li key={line.key} className="rounded border border-line p-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{line.item.name}</p>
                      {line.variantName !== 'default' && (
                        <p className="text-xs text-muted">{line.variantName}</p>
                      )}
                      {line.modifiers.length > 0 && (
                        <p className="text-xs text-muted">
                          {line.modifiers.map((m) => m.name).join('، ')}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setCart((l) => l.filter((x) => x.key !== line.key))}
                      aria-label={`حذف ${line.item.name}`}
                      className="text-muted hover:text-danger"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon"
                        variant="outline"
                        aria-label="إنقاص"
                        onClick={() =>
                          setCart((l) =>
                            line.quantity <= 1
                              ? l.filter((x) => x.key !== line.key)
                              : l.map((x) =>
                                  x.key === line.key ? { ...x, quantity: x.quantity - 1 } : x,
                                ),
                          )
                        }
                      >
                        <Minus className="h-4 w-4" />
                      </Button>
                      <span className="lb-numeric w-9 text-center font-semibold">
                        {line.quantity}
                      </span>
                      <Button
                        size="icon"
                        variant="outline"
                        aria-label="زيادة"
                        onClick={() =>
                          setCart((l) =>
                            l.map((x) =>
                              x.key === line.key ? { ...x, quantity: x.quantity + 1 } : x,
                            ),
                          )
                        }
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                    <span className="lb-numeric font-semibold">
                      {formatMoney(
                        Math.round(
                          (line.unitPriceCents +
                            line.modifiers.reduce((s, m) => s + m.priceCents, 0)) *
                            line.quantity,
                        ),
                        currency,
                      )}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex justify-between border-t border-line pt-3 text-base font-bold">
          <span>الإجمالي (شامل الضريبة)</span>
          <span className="lb-numeric">{formatMoney(cartTotal, currency)}</span>
        </div>

        <Button size="touch" block disabled={cart.length === 0 || isPending} onClick={submitOrder}>
          {isPending ? 'جارٍ الحفظ…' : 'إرسال الطلب'}
        </Button>
      </aside>

      {/* Modifier picker */}
      <ConfirmDialog
        open={picking !== null}
        title={picking?.item.name ?? ''}
        description="اختر الإضافات المطلوبة."
        confirmLabel="إضافة للطلب"
        tone="primary"
        onCancel={() => {
          setPicking(null);
          setError(null);
        }}
        onConfirm={confirmModifiers}
      >
        <div className="max-h-72 space-y-4 overflow-y-auto">
          {picking &&
            groupsFor(picking.item.id).map((group) => (
              <fieldset key={group.id}>
                <legend className="mb-2 text-sm font-semibold">
                  {group.name}
                  <span className="ms-2 text-xs font-normal text-muted">
                    {group.minSelect > 0 ? `مطلوب ${group.minSelect}` : 'اختياري'}
                    {group.maxSelect > 1 && ` · حتى ${group.maxSelect}`}
                  </span>
                </legend>
                <div className="space-y-1">
                  {group.modifiers.map((modifier) => {
                    const picked = (chosen[group.id] ?? []).includes(modifier.id);
                    const single = group.maxSelect === 1;
                    return (
                      <label
                        key={modifier.id}
                        className={cn(
                          'flex cursor-pointer items-center justify-between gap-2 rounded border p-2 text-sm',
                          picked ? 'border-primary bg-primary-soft' : 'border-line',
                        )}
                      >
                        <span className="flex items-center gap-2">
                          <input
                            type={single ? 'radio' : 'checkbox'}
                            name={group.id}
                            checked={picked}
                            onChange={() =>
                              setChosen((c) => {
                                const current = c[group.id] ?? [];
                                if (single) return { ...c, [group.id]: [modifier.id] };
                                return {
                                  ...c,
                                  [group.id]: picked
                                    ? current.filter((x) => x !== modifier.id)
                                    : [...current, modifier.id].slice(0, group.maxSelect),
                                };
                              })
                            }
                            className="h-4 w-4"
                          />
                          {modifier.name}
                        </span>
                        {modifier.priceCents > 0 && (
                          <span className="lb-numeric text-muted">
                            +{formatMoney(modifier.priceCents, currency)}
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            ))}
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      </ConfirmDialog>

      {/* Settle */}
      <ConfirmDialog
        open={settling !== null}
        title={`تحصيل الطلب #${settling?.number ?? ''}`}
        description={
          settling ? `المستحق: ${formatMoney(settling.totalCents - settling.paidCents, currency)}` : ''
        }
        confirmLabel="تأكيد التحصيل"
        tone="primary"
        busy={isPending}
        onCancel={() => setSettling(null)}
        onConfirm={settle}
      >
        <div className="space-y-3">
          <div>
            <label htmlFor="pay-method" className="mb-1 block text-sm font-medium">
              طريقة الدفع
            </label>
            <Select id="pay-method" value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="cash">نقدي</option>
              <option value="card">بطاقة</option>
              <option value="transfer">تحويل</option>
              <option value="wallet">محفظة</option>
              <option value="other">أخرى</option>
            </Select>
          </div>
          <div>
            <label htmlFor="pay-tendered" className="mb-1 block text-sm font-medium">
              المبلغ المدفوع
            </label>
            <Input
              id="pay-tendered"
              value={tendered}
              onChange={(e) => setTendered(e.target.value)}
              inputMode="decimal"
              dir="ltr"
              placeholder={settling ? ((settling.totalCents - settling.paidCents) / 100).toFixed(2) : ''}
              className="h-12 text-lg"
            />
            <p className="mt-1 text-xs text-muted">
              اتركه فارغًا للتحصيل بالكامل، أو أدخل مبلغًا أقل لتحصيل جزئي.
            </p>
          </div>
          {canDiscount && (
            <div>
              <label htmlFor="pay-discount" className="mb-1 block text-sm font-medium">
                خصم
              </label>
              <Input
                id="pay-discount"
                value={discount}
                onChange={(e) => setDiscount(e.target.value)}
                inputMode="decimal"
                dir="ltr"
                placeholder="0.00"
              />
            </div>
          )}
        </div>
      </ConfirmDialog>

      {/* Cancel */}
      <ConfirmDialog
        open={cancelling !== null}
        title={`إلغاء الطلب #${cancelling?.number ?? ''}`}
        description="سيتم تسجيل الإلغاء في سجل النشاط. لا يمكن التراجع."
        confirmLabel="إلغاء الطلب"
        busy={isPending}
        onCancel={() => {
          setCancelling(null);
          setCancelReason('');
        }}
        onConfirm={cancelOrder}
      >
        <div>
          <label htmlFor="cancel-reason" className="mb-1 block text-sm font-medium">
            سبب الإلغاء
          </label>
          <Input
            id="cancel-reason"
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            required
            maxLength={300}
          />
        </div>
      </ConfirmDialog>

      {/* Receipt */}
      <ConfirmDialog
        open={receipt !== null}
        title={`إيصال ${receipt?.number ?? ''}`}
        confirmLabel="تم"
        cancelLabel="إغلاق"
        tone="primary"
        onCancel={() => setReceipt(null)}
        onConfirm={() => setReceipt(null)}
      >
        {receipt && (
          <dl className="space-y-2 rounded border border-line p-4 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted">الإجمالي</dt>
              <dd className="lb-numeric font-semibold">{formatMoney(receipt.total, currency)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">المدفوع</dt>
              <dd className="lb-numeric">{formatMoney(receipt.paid, currency)}</dd>
            </div>
            {receipt.due > 0 && (
              <div className="flex justify-between text-warn">
                <dt>المتبقي</dt>
                <dd className="lb-numeric font-semibold">{formatMoney(receipt.due, currency)}</dd>
              </div>
            )}
            <div className="flex justify-between border-t border-line pt-2">
              <dt className="font-semibold">الباقي للعميل</dt>
              <dd className="lb-numeric text-lg font-bold text-success">
                {formatMoney(receipt.change, currency)}
              </dd>
            </div>
          </dl>
        )}
      </ConfirmDialog>
    </div>
  );
}
