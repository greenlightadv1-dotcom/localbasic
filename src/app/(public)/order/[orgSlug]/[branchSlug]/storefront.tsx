'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Minus, Plus } from 'lucide-react';
import { checkoutAction, quoteCartAction, getOrderVerificationInfoAction } from '../../actions';
import { FULFILLMENT_LABELS, FULFILLMENT_TYPES, type Fulfillment } from '@/modules/restaurant/online/schemas';
import type { MenuItem, ModifierGroup, Quote } from '@/modules/restaurant/online/service';
import { cn } from '@/lib/cn';
import { getDeviceId } from '@/modules/restaurant/guest-verification/device';
import { getBrowserLocation } from '@/modules/restaurant/guest-verification/geolocation';
import { buildWhatsAppVerifyUrl } from '@/modules/restaurant/guest-verification/whatsapp';
import { CustomerProfileSheet, StoreBottomNav, useProfileSheet } from '@/components/menu/customer-profile';
import type { ProfileAddress, ReorderLine } from '@/modules/restaurant/customer/types';
import { OrderStatusBanner, rememberActiveOrder } from '@/components/menu/order-status-banner';
import { PaymentOptionsList } from '@/components/menu/payment-options';
import type { PaymentOptions } from '@/modules/restaurant/payments/options';
import { GuestVerifySheet } from '@/modules/restaurant/guest-verification/verify-sheet';
import { useOrderStatusBroadcast } from '@/modules/restaurant/guest-verification/use-order-status';
import {
  BottomSheet, CartBar, CategoryRail, CategorySection, FoodCard, FoodGrid,
} from '@/components/menu/food-ui';

type Line = { variantId: string; quantity: number; modifierIds: string[]; note?: string };

function money(cents: number, currency: string) {
  return `${(cents / 100).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ${currency}`;
}

const FIELD =
  'h-12 w-full rounded-[14px] border border-line bg-elevated px-3.5 text-base text-fg transition-colors focus:border-primary focus:outline-none';

/**
 * Guest storefront: a mobile-first food-ordering menu.
 *
 * No account, no password, no SMS OTP — a phone number plus this browser's
 * device id is the only identity involved, exactly like the table-QR flow
 * (/p/[token]). A first-time (device, phone) pair sees the WhatsApp
 * verification step before its order reaches the cashier; a recognised one
 * skips it. A returning guest sees one line ("ordering as …") and a single
 * confirm button instead of the form.
 *
 * The cart lives here, in the browser, and is never persisted as a priced
 * thing: the numbers shown come from quoteCartAction, which re-reads the menu
 * on the server. If this component lied about a price, checkout would simply
 * charge the real one.
 */
export function Storefront({
  orgSlug,
  branchSlug,
  items,
  modifierGroups,
  currency,
  pickupEnabled,
  deliveryEnabled,
  paymentOptions,
}: {
  orgSlug: string;
  branchSlug: string;
  items: MenuItem[];
  modifierGroups: ModifierGroup[];
  currency: string;
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
  paymentOptions: PaymentOptions;
}) {
  // Only the options the branch actually offers. The server refuses anything
  // else regardless, so this is presentation, not enforcement.
  const offered = FULFILLMENT_TYPES.filter(
    (f) => (f === 'pickup' ? pickupEnabled : deliveryEnabled),
  );
  const [lines, setLines] = useState<Line[]>([]);
  const [fulfillment, setFulfillment] = useState<Fulfillment>(offered[0] ?? 'pickup');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [pricing, startPricing] = useTransition();

  // A returning guest's name/phone are remembered locally so they are not
  // retyped on the next visit — on this device only. The keys are shared
  // with the table-QR ordering flow (/p/[token]).
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  // True only when BOTH were remembered from an earlier visit; decides whether
  // the form opens collapsed to "ordering as …". Set once, never while typing.
  const [prefilled, setPrefilled] = useState(false);
  const [editingIdentity, setEditingIdentity] = useState(false);
  useEffect(() => {
    try {
      const n = localStorage.getItem('lb-guest-name') ?? '';
      const p = localStorage.getItem('lb-guest-phone') ?? '';
      setName(n);
      setPhone(p);
      setPrefilled(n.trim().length >= 2 && p.trim().length >= 6);
    } catch {
      // Private browsing or a blocked store: fields just start empty.
    }
  }, []);
  const identityCollapsed = prefilled && !editingIdentity;

  const formRef = useRef<HTMLFormElement>(null);
  const [deviceId, setDeviceId] = useState('');
  const [isSubmitting, startSubmitTransition] = useTransition();
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);
  // Set once the order exists and is still 'pending_verification' — its
  // presence is what switches the panel from the cart form to the WhatsApp
  // sheet. token is kept alongside it so the realtime subscription and the
  // eventual redirect both have it.
  const [verification, setVerification] = useState<
    { token: string; code: string; whatsappUrl: string } | null
  >(null);

  useEffect(() => {
    setDeviceId(getDeviceId());
  }, []);

  // The gateway webhook (0086) advances a verified order to 'new' from the
  // outside; this is what notices without the customer doing anything.
  useOrderStatusBroadcast(verification?.token ?? null, (status) => {
    if (status === 'new') finishOrder(verification!.token);
  });

  /**
   * The order exists and is past verification: keep the guest on the menu,
   * clear the cart and pin the live status banner instead of sending them to
   * a separate tracking page.
   */
  function finishOrder(token: string) {
    setVerification(null);
    setLines([]);
    setQuote(null);
    setQuoteError(null);
    setCartOpen(false);
    rememberActiveOrder(`${orgSlug}/${branchSlug}`, token);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const loadStatus = useCallback(async (token: string) => {
    const info = await getOrderVerificationInfoAction(token);
    return info.ok ? info.data.status : null;
  }, []);

  /**
   * The order is always created — device/phone verification never blocks
   * checkout, it only decides whether the server starts the order at 'new'
   * or 'pending_verification'. Read that back by the token checkout just
   * returned and either go straight to tracking or show the WhatsApp step.
   */
  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = formRef.current;
    if (!form) return;
    setOrderError(null);
    const data = new FormData(form);
    const location = await getBrowserLocation();
    if (location) {
      data.set('latitude', String(location.latitude));
      data.set('longitude', String(location.longitude));
    }
    data.set('deviceId', deviceId);

    startSubmitTransition(async () => {
      const placed = await checkoutAction(data);
      if (!placed.ok) {
        setOrderError(placed.error);
        return;
      }
      const info = await getOrderVerificationInfoAction(placed.data.token);
      if (info.ok && info.data.status === 'pending_verification' && info.data.code) {
        setVerification({
          token: placed.data.token,
          code: info.data.code,
          whatsappUrl: buildWhatsAppVerifyUrl(info.data.code),
        });
        return;
      }
      finishOrder(placed.data.token);
    });
  }

  function recheckVerification() {
    if (!verification) return;
    setCheckingStatus(true);
    startSubmitTransition(async () => {
      const info = await getOrderVerificationInfoAction(verification.token);
      setCheckingStatus(false);
      if (info.ok && info.data.status !== 'pending_verification') {
        finishOrder(verification.token);
      }
    });
  }

  // One key per checkout attempt, so a double-click or a retry is recognised
  // server-side as the same attempt rather than a second order.
  //
  // crypto.randomUUID(), not Math.random(): presenting an existing key makes
  // the server hand back that order's tracking token, so the key is a capability
  // and has to be unguessable.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const groupsByProduct = useMemo(() => {
    const m = new Map<string, ModifierGroup[]>();
    for (const g of modifierGroups) {
      m.set(g.productId, [...(m.get(g.productId) ?? []), g]);
    }
    return m;
  }, [modifierGroups]);

  function repriceWith(next: Line[], nextFulfillment: Fulfillment) {
    if (next.length === 0) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    startPricing(async () => {
      const res = await quoteCartAction({
        orgSlug, branchSlug, items: next, fulfillment: nextFulfillment,
      });
      if ('error' in res && res.error) {
        setQuote(null);
        setQuoteError(res.error);
      } else if ('quote' in res && res.quote) {
        setQuote(res.quote);
        setQuoteError(null);
      }
    });
  }

  function add(item: MenuItem, modifierIds: string[]) {
    const next = [...lines];
    const at = next.findIndex(
      (l) => l.variantId === item.variantId &&
        l.modifierIds.slice().sort().join() === modifierIds.slice().sort().join(),
    );
    if (at >= 0) next[at] = { ...next[at]!, quantity: next[at]!.quantity + 1 };
    else next.push({ variantId: item.variantId, quantity: 1, modifierIds });
    setLines(next);
    repriceWith(next, fulfillment);
  }

  function setQty(index: number, quantity: number) {
    const next = quantity <= 0
      ? lines.filter((_, i) => i !== index)
      : lines.map((l, i) => (i === index ? { ...l, quantity } : l));
    setLines(next);
    repriceWith(next, fulfillment);
    if (next.length === 0) setCartOpen(false);
  }

  function changeFulfillment(f: Fulfillment) {
    setFulfillment(f);
    repriceWith(lines, f);
  }

  const byVariant = useMemo(
    () => new Map(items.map((i) => [i.variantId, i])), [items],
  );

  // ---- guest profile: reorder + saved addresses -------------------------
  const profileSheet = useProfileSheet();
  const [activeOrders, setActiveOrders] = useState(0);
  const [addressPrefill, setAddressPrefill] = useState<{ n: number; a: ProfileAddress } | null>(null);

  /** Adds a past order's lines to the cart; unavailable items are skipped. */
  function reorder(past: ReorderLine[]): { added: number; skipped: number } {
    const knownModifiers = new Set(modifierGroups.flatMap((g) => g.modifiers.map((m) => m.id)));
    const next = [...lines];
    let added = 0;
    let skipped = 0;
    for (const l of past) {
      if (!byVariant.has(l.variantId)) { skipped += 1; continue; }
      const modifierIds = l.modifierIds.filter((id) => knownModifiers.has(id));
      const at = next.findIndex(
        (x) => x.variantId === l.variantId && x.modifierIds.slice().sort().join() === modifierIds.slice().sort().join(),
      );
      if (at >= 0) next[at] = { ...next[at]!, quantity: next[at]!.quantity + l.quantity };
      else next.push({ variantId: l.variantId, quantity: l.quantity, modifierIds, note: l.note ?? undefined });
      added += 1;
    }
    if (added > 0) {
      setLines(next);
      repriceWith(next, fulfillment);
      setCartOpen(true);
    }
    return { added, skipped };
  }

  function applyAddress(a: ProfileAddress) {
    if (deliveryEnabled) changeFulfillment('delivery');
    setAddressPrefill((p) => ({ n: (p?.n ?? 0) + 1, a }));
    setCartOpen(true);
  }

  // Categories in first-seen order — the order the menu screen shows them in,
  // since both read sort_order off the same restaurant_categories table. The
  // rail's round icon is the category's first item photo.
  const categories = useMemo(() => {
    const seen = new Map<string, { id: string; name: string; imageUrl: string | null; items: MenuItem[] }>();
    for (const item of items) {
      const id = item.categoryId ?? '__uncategorised__';
      const entry = seen.get(id) ?? { id, name: item.categoryName ?? 'أصناف أخرى', imageUrl: null, items: [] };
      entry.items.push(item);
      entry.imageUrl ??= item.imageUrl;
      seen.set(id, entry);
    }
    return [...seen.values()];
  }, [items]);

  const itemCount = lines.reduce((n, l) => n + l.quantity, 0);
  const countFor = (variantId: string) =>
    lines.filter((l) => l.variantId === variantId).reduce((n, l) => n + l.quantity, 0);

  // The item whose options (modifiers) the guest is choosing.
  const [picking, setPicking] = useState<MenuItem | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [pickError, setPickError] = useState<string | null>(null);

  function beginAdd(item: MenuItem) {
    const groups = groupsByProduct.get(item.productId) ?? [];
    if (groups.length === 0) {
      add(item, []);
      return;
    }
    setChosen([]);
    setPickError(null);
    setPicking(item);
  }

  function toggleModifier(g: ModifierGroup, id: string) {
    const inGroup = g.modifiers.map((m) => m.id);
    const others = chosen.filter((c) => !inGroup.includes(c));
    const mine = chosen.filter((c) => inGroup.includes(c));
    if (mine.includes(id)) setChosen([...others, ...mine.filter((m) => m !== id)]);
    else if (g.maxSelect === 1) setChosen([...others, id]);
    else if (mine.length < g.maxSelect) setChosen([...others, ...mine, id]);
  }

  function confirmPicking() {
    if (!picking) return;
    for (const g of groupsByProduct.get(picking.productId) ?? []) {
      const inGroup = g.modifiers.map((m) => m.id);
      const count = chosen.filter((c) => inGroup.includes(c)).length;
      if (count < g.minSelect) {
        setPickError(`اختر ${g.minSelect > 1 ? `${g.minSelect} على الأقل من` : 'من'} «${g.groupName}»`);
        return;
      }
    }
    add(picking, chosen);
    setPicking(null);
  }

  const cardName = (item: MenuItem) =>
    item.variantName !== 'default' ? `${item.productName} — ${item.variantName}` : item.productName;

  return (
    <div className="pb-40">
      <OrderStatusBanner scopeKey={`${orgSlug}/${branchSlug}`} loadStatus={loadStatus} />
      <StoreBottomNav cartCount={itemCount} onCart={() => setCartOpen(true)} hasActiveOrder={activeOrders > 0} />
      {profileSheet.open ? (
        <CustomerProfileSheet
          scope={{ kind: 'slug', orgSlug }}
          onClose={() => profileSheet.setOpen(false)}
          onReorder={reorder}
          onUseAddress={applyAddress}
          onActiveOrders={setActiveOrders}
        />
      ) : null}
      <CategoryRail categories={categories.map((c) => ({ id: c.id, name: c.name, imageUrl: c.imageUrl }))} />

      {categories.map((c) => (
        <CategorySection key={c.id} id={c.id} name={c.name}>
          <FoodGrid>
            {c.items.map((item) => (
              <FoodCard
                key={item.variantId}
                name={cardName(item)}
                description={item.description}
                priceLabel={money(item.priceCents, currency)}
                imageUrl={item.imageUrl}
                categoryName={c.name}
                count={countFor(item.variantId)}
                onAdd={() => beginAdd(item)}
              />
            ))}
          </FoodGrid>
        </CategorySection>
      ))}

      <CartBar
        count={itemCount}
        totalLabel={quote ? money(quote.totalCents, quote.currency) : null}
        onClick={() => setCartOpen(true)}
      />

      {picking ? (
        <BottomSheet title={cardName(picking)} onClose={() => setPicking(null)}>
          {pickError ? <p className="mb-3 rounded-[13px] bg-danger/10 px-3 py-2 text-sm text-danger">{pickError}</p> : null}
          <div className="space-y-4">
            {(groupsByProduct.get(picking.productId) ?? []).map((g) => (
              <fieldset key={g.groupId}>
                <legend className="mb-2 text-sm font-bold text-fg">
                  {g.groupName}
                  <span className="ms-2 text-xs font-normal text-muted">
                    {g.minSelect > 0 ? 'مطلوب' : 'اختياري'}
                    {g.maxSelect > 1 ? ` · حتى ${g.maxSelect}` : ''}
                  </span>
                </legend>
                <div className="flex flex-wrap gap-2">
                  {g.modifiers.map((m) => {
                    const on = chosen.includes(m.id);
                    return (
                      <button
                        key={m.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleModifier(g, m.id)}
                        className={cn(
                          'min-h-11 rounded-full border px-4 text-sm font-semibold transition-colors',
                          on ? 'border-primary bg-primary text-primary-fg' : 'border-line bg-elevated text-fg',
                        )}
                      >
                        {m.name}
                        {m.priceCents > 0 ? ` +${money(m.priceCents, currency)}` : ''}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            ))}
          </div>
          <button
            type="button"
            onClick={confirmPicking}
            className="mt-5 flex h-13 min-h-[52px] w-full items-center justify-center gap-2 rounded-full bg-primary text-base font-extrabold text-primary-fg"
          >
            <Plus className="h-5 w-5" aria-hidden="true" /> أضف للسلة
          </button>
        </BottomSheet>
      ) : null}

      {cartOpen ? (
        <BottomSheet title="سلتك" onClose={() => setCartOpen(false)}>
          {lines.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted">السلة فارغة.</p>
          ) : (
            <ul className="space-y-3 border-b border-line pb-3">
              {lines.map((l, i) => {
                const item = byVariant.get(l.variantId);
                return (
                  <li key={`${l.variantId}-${i}`} className="flex items-center gap-3 text-sm">
                    <span className="min-w-0 flex-1 font-semibold text-fg">
                      {item ? cardName(item) : ''}
                      {l.modifierIds.length > 0 ? (
                        <span className="font-normal text-muted"> (+{l.modifierIds.length})</span>
                      ) : null}
                    </span>
                    <div className="flex items-center gap-1 rounded-full border border-line p-0.5">
                      <button
                        type="button"
                        aria-label="إنقاص"
                        onClick={() => setQty(i, l.quantity - 1)}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-fg hover:bg-surface"
                      ><Minus className="h-4 w-4" aria-hidden="true" /></button>
                      <span className="lb-numeric w-6 text-center font-bold">{l.quantity}</span>
                      <button
                        type="button"
                        aria-label="زيادة"
                        onClick={() => setQty(i, l.quantity + 1)}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-fg hover:bg-surface"
                      ><Plus className="h-4 w-4" aria-hidden="true" /></button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {offered.length > 1 ? (
            <div className="mt-3 flex gap-2">
              {offered.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => changeFulfillment(f)}
                  aria-pressed={fulfillment === f}
                  className={cn(
                    'min-h-11 flex-1 rounded-full px-3 text-sm font-bold transition-colors',
                    fulfillment === f ? 'bg-primary text-primary-fg' : 'border border-line text-muted hover:text-fg',
                  )}
                >
                  {FULFILLMENT_LABELS[f]}
                </button>
              ))}
            </div>
          ) : null}

          {/* Every figure below comes back from the server. */}
          <div className="mt-3 space-y-1.5 text-sm" aria-live="polite">
            {quoteError ? <p className="text-danger">{quoteError}</p> : null}
            {pricing ? <p className="text-muted">جارٍ الحساب…</p> : null}
            {quote ? (
              <>
                <div className="flex justify-between text-muted">
                  <span>الإجمالي الفرعي</span><span className="lb-numeric">{money(quote.subtotalCents, quote.currency)}</span>
                </div>
                {quote.taxCents > 0 ? (
                  <div className="flex justify-between text-muted">
                    <span>الضريبة</span><span className="lb-numeric">{money(quote.taxCents, quote.currency)}</span>
                  </div>
                ) : null}
                {quote.deliveryFeeCents > 0 ? (
                  <div className="flex justify-between text-muted">
                    <span>التوصيل</span><span className="lb-numeric">{money(quote.deliveryFeeCents, quote.currency)}</span>
                  </div>
                ) : null}
                <div className="flex justify-between border-t border-line pt-2 text-base font-extrabold text-fg">
                  <span>الإجمالي</span>
                  <span data-testid="cart-total" className="lb-numeric">{money(quote.totalCents, quote.currency)}</span>
                </div>
              </>
            ) : null}
          </div>

          <form ref={formRef} onSubmit={handleSubmit} className="mt-4 space-y-3">
            <input type="hidden" name="orgSlug" value={orgSlug} />
            <input type="hidden" name="branchSlug" value={branchSlug} />
            <input type="hidden" name="fulfillment" value={fulfillment} />
            <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
            <input type="hidden" name="items" value={JSON.stringify(lines)} />

            {orderError ? (
              <p className="rounded-[13px] border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                {orderError}
              </p>
            ) : null}

            {/* Name + phone only. A returning guest sees who the order is for
                instead of the fields; the values still travel as hidden inputs. */}
            {identityCollapsed ? (
              <div className="flex items-center justify-between gap-3 rounded-[14px] bg-primary-soft px-4 py-3 text-sm">
                <div className="min-w-0">
                  <p className="text-xs text-muted">الطلب باسم</p>
                  <p className="truncate font-bold text-fg">{name}</p>
                  <p className="lb-numeric text-muted" dir="ltr">{phone}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setEditingIdentity(true)}
                  className="shrink-0 rounded-full border border-primary/40 px-3 py-1.5 text-xs font-bold text-primary"
                >
                  تغيير
                </button>
                <input type="hidden" name="customerName" value={name} />
                <input type="hidden" name="customerPhone" value={phone} />
              </div>
            ) : (
              <>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-semibold text-fg">الاسم</span>
                  <input name="customerName" required minLength={2} maxLength={120} autoComplete="name" value={name}
                    onChange={(e) => setName(e.target.value)} className={FIELD} />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-semibold text-fg">رقم الهاتف</span>
                  <input name="customerPhone" type="tel" inputMode="tel" required minLength={6} maxLength={32} dir="ltr"
                    autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className={FIELD} />
                  <span className="mt-1 block text-xs text-muted">لتأكيد طلبك على واتساب. لا حاجة لحساب أو كلمة مرور.</span>
                </label>
              </>
            )}

            {fulfillment === 'delivery' ? (
              <>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-semibold text-fg">العنوان</span>
                  <input key={`a${addressPrefill?.n ?? 0}`} name="address" required maxLength={500} defaultValue={addressPrefill?.a.address} className={FIELD} />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="mb-1.5 block text-sm font-semibold text-fg">المدينة</span>
                    <input key={`c${addressPrefill?.n ?? 0}`} name="city" maxLength={120} defaultValue={addressPrefill?.a.city ?? undefined} className={FIELD} />
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-sm font-semibold text-fg">المنطقة</span>
                    <input key={`r${addressPrefill?.n ?? 0}`} name="area" maxLength={120} defaultValue={addressPrefill?.a.area ?? undefined} className={FIELD} />
                  </label>
                </div>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-semibold text-fg">علامة مميزة</span>
                  <input key={`l${addressPrefill?.n ?? 0}`} name="landmark" maxLength={240} defaultValue={addressPrefill?.a.landmark ?? undefined} className={FIELD} />
                </label>
              </>
            ) : null}

            <label className="block">
              <span className="mb-1.5 block text-sm font-semibold text-fg">ملاحظات (اختياري)</span>
              <input name="note" maxLength={500} className={FIELD} />
            </label>

            <PaymentOptionsList options={paymentOptions} />

            {verification ? (
              <GuestVerifySheet
                code={verification.code}
                whatsappUrl={verification.whatsappUrl}
                checking={checkingStatus}
                error={null}
                onRecheck={recheckVerification}
              />
            ) : lines.length > 0 ? (
              <button
                type="submit"
                disabled={isSubmitting}
                className="h-14 w-full rounded-full bg-primary text-base font-extrabold text-primary-fg transition-opacity disabled:opacity-50"
              >
                {isSubmitting ? 'جارٍ إرسال الطلب…' : 'تأكيد الطلب'}
              </button>
            ) : null}
            <p className="text-center text-xs text-muted">
              الأسعار تُحسب على الخادم.
            </p>
          </form>
        </BottomSheet>
      ) : null}
    </div>
  );
}
