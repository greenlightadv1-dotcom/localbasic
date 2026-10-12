'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown } from 'lucide-react';
import { checkoutAction, quoteCartAction, getOrderVerificationInfoAction } from '../../actions';
import { FULFILLMENT_LABELS, FULFILLMENT_TYPES, type Fulfillment } from '@/modules/restaurant/online/schemas';
import type { MenuItem, ModifierGroup, Quote } from '@/modules/restaurant/online/service';
import { cn } from '@/lib/cn';
import { getDeviceId } from '@/modules/restaurant/guest-verification/device';
import { getBrowserLocation } from '@/modules/restaurant/guest-verification/geolocation';
import { buildWhatsAppVerifyUrl } from '@/modules/restaurant/guest-verification/whatsapp';
import { GuestVerifySheet } from '@/modules/restaurant/guest-verification/verify-sheet';
import { useOrderStatusBroadcast } from '@/modules/restaurant/guest-verification/use-order-status';

type Line = { variantId: string; quantity: number; modifierIds: string[]; note?: string };

function money(cents: number, currency: string) {
  return `${(cents / 100).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ${currency}`;
}

/**
 * Guest storefront.
 *
 * No account, no password, no SMS OTP — a phone number plus this browser's
 * device id is the only identity involved, exactly like the table-QR flow
 * (/p/[token]). A first-time (device, phone) pair sees the WhatsApp
 * verification step before checkout completes; a recognised one skips it.
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
}: {
  orgSlug: string;
  branchSlug: string;
  items: MenuItem[];
  modifierGroups: ModifierGroup[];
  currency: string;
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
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
  // Mobile only: the cart/checkout panel is an overlay opened from the sticky
  // bottom bar, rather than something to scroll all the way down to. Unused
  // above `lg:`, where the panel is always visible in its own column.
  const [mobileCartOpen, setMobileCartOpen] = useState(false);
  const [pricing, startPricing] = useTransition();

  // A returning guest's name/phone are remembered locally so they are not
  // retyped on the next visit — on this device only. The keys are shared
  // with the table-QR ordering flow (/p/[token]).
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  useEffect(() => {
    try {
      setName(localStorage.getItem('lb-guest-name') ?? '');
      setPhone(localStorage.getItem('lb-guest-phone') ?? '');
    } catch {
      // Private browsing or a blocked store: fields just start empty.
    }
  }, []);

  const router = useRouter();
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
    { token: string; code: string; whatsappUrl: string | null } | null
  >(null);

  useEffect(() => {
    setDeviceId(getDeviceId());
  }, []);

  // The gateway webhook (0086) advances a verified order to 'new' from the
  // outside; this is what notices without the customer doing anything.
  useOrderStatusBroadcast(verification?.token ?? null, (status) => {
    if (status === 'new') router.push(`/order/track/${verification!.token}`);
  });

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
          whatsappUrl: buildWhatsAppVerifyUrl(info.data.whatsapp, info.data.code),
        });
        return;
      }
      router.push(`/order/track/${placed.data.token}`);
    });
  }

  function recheckVerification() {
    if (!verification) return;
    setCheckingStatus(true);
    startSubmitTransition(async () => {
      const info = await getOrderVerificationInfoAction(verification.token);
      setCheckingStatus(false);
      if (info.ok && info.data.status !== 'pending_verification') {
        router.push(`/order/track/${verification.token}`);
      }
    });
  }

  // One key per checkout attempt, so a double-click or a retry is recognised
  // server-side as the same attempt rather than a second order.
  //
  // crypto.randomUUID(), not Math.random(): presenting an existing key makes
  // the server hand back that order's tracking token, so the key is a capability
  // and has to be unguessable. The retail storefront already generates it this
  // way; this one did not.
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
  }

  function changeFulfillment(f: Fulfillment) {
    setFulfillment(f);
    repriceWith(lines, f);
  }

  const byVariant = useMemo(
    () => new Map(items.map((i) => [i.variantId, i])), [items],
  );

  // Categories, in first-seen order — the same order the menu screen and the
  // Site Engine's own menu section already show them in, since both read
  // sort_order off the same restaurant_categories table this list is
  // derived from. `null` is the "الكل" tab: no filter, everything shown.
  const categories = useMemo(() => {
    const seen = new Map<string, string>();
    for (const item of items) {
      const key = item.categoryId ?? '__uncategorised__';
      if (!seen.has(key)) seen.set(key, item.categoryName ?? 'أصناف أخرى');
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [items]);

  // One accordion section per category, collapsed by default except the
  // first — the pill-row filter this replaces showed every category's name
  // at once but only one category's items; this shows every category's items
  // are one tap away, with just the first section's worth of clutter on
  // screen to start.
  const itemsByCategory = useMemo(() => {
    const m = new Map<string, MenuItem[]>();
    for (const item of items) {
      const key = item.categoryId ?? '__uncategorised__';
      m.set(key, [...(m.get(key) ?? []), item]);
    }
    return m;
  }, [items]);

  const [openCategories, setOpenCategories] = useState<Set<string>>(
    () => new Set(categories[0] ? [categories[0].id] : []),
  );

  function toggleCategory(id: string) {
    setOpenCategories((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const itemCount = lines.reduce((n, l) => n + l.quantity, 0);

  return (
    <div className="grid gap-8 pb-24 lg:grid-cols-[1.4fr_1fr] lg:pb-0">
      <section>
        <h2 className="mb-4 font-reem text-lg font-normal tracking-wide text-fg">المنيو</h2>

        {categories.length > 1 ? (
          <div className="space-y-2">
            {categories.map((c) => {
              const catItems = itemsByCategory.get(c.id) ?? [];
              const isOpen = openCategories.has(c.id);
              return (
                <div
                  key={c.id}
                  className="overflow-hidden rounded-[16px] border border-line bg-elevated"
                >
                  <button
                    type="button"
                    onClick={() => toggleCategory(c.id)}
                    aria-expanded={isOpen}
                    className="flex min-h-12 w-full items-center justify-between gap-2 px-4 py-3 text-start"
                  >
                    <span className="font-semibold text-fg">{c.name}</span>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-muted">
                      <span className="lb-numeric">{catItems.length}</span>
                      <ChevronDown
                        className={cn('h-4 w-4 transition-transform', isOpen && 'rotate-180')}
                        aria-hidden="true"
                      />
                    </span>
                  </button>
                  {isOpen && (
                    <ul className="animate-fade-in space-y-2 border-t border-line p-2.5">
                      {catItems.map((item) => (
                        <MenuRow
                          key={item.variantId}
                          item={item}
                          groups={groupsByProduct.get(item.productId) ?? []}
                          currency={currency}
                          onAdd={add}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => (
              <MenuRow
                key={item.variantId}
                item={item}
                groups={groupsByProduct.get(item.productId) ?? []}
                currency={currency}
                onAdd={add}
              />
            ))}
          </ul>
        )}
      </section>

      <section
        className={cn(
          'lg:sticky lg:top-4 lg:block lg:self-start',
          mobileCartOpen
            ? 'fixed inset-0 z-30 overflow-y-auto bg-bg p-4'
            : 'hidden',
        )}
      >
        <div className="mb-4 flex items-center justify-between lg:mb-4">
          <h2 className="font-reem text-lg font-normal tracking-wide text-fg">سلتك</h2>
          <button
            type="button"
            onClick={() => setMobileCartOpen(false)}
            aria-label="إغلاق السلة"
            className="flex h-11 w-11 items-center justify-center rounded-[12px] border border-line text-xl text-muted lg:hidden"
          >
            ✕
          </button>
        </div>

        <div className="rounded-[22px] border border-line bg-elevated p-4 shadow-[0_18px_44px_rgba(0,0,0,.2)]">
          {lines.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted">السلة فارغة.</p>
          ) : (
            <ul className="space-y-3 border-b border-line pb-3">
              {lines.map((l, i) => {
                const item = byVariant.get(l.variantId);
                return (
                  <li key={`${l.variantId}-${i}`} className="flex items-center gap-2 text-sm">
                    <span className="flex-1 text-fg">
                      {item?.productName}
                      {l.modifierIds.length > 0 ? (
                        <span className="text-muted"> (+{l.modifierIds.length})</span>
                      ) : null}
                    </span>
                    <div className="flex items-center gap-1 rounded-full border border-line p-0.5">
                      <button
                        type="button"
                        aria-label="إنقاص"
                        onClick={() => setQty(i, l.quantity - 1)}
                        className="flex h-7 w-7 items-center justify-center rounded-full text-fg hover:bg-surface"
                      >−</button>
                      <span className="w-6 text-center font-semibold lb-numeric">{l.quantity}</span>
                      <button
                        type="button"
                        aria-label="زيادة"
                        onClick={() => setQty(i, l.quantity + 1)}
                        className="flex h-7 w-7 items-center justify-center rounded-full text-fg hover:bg-surface"
                      >+</button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mt-3 flex gap-2">
            {offered.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => changeFulfillment(f)}
                className={cn(
                  'flex-1 rounded-full px-3 py-2 text-sm font-semibold transition-colors',
                  fulfillment === f
                    ? 'bg-[rgb(var(--brand-primary))] text-white'
                    : 'border border-line text-muted hover:text-fg',
                )}
              >
                {FULFILLMENT_LABELS[f]}
              </button>
            ))}
          </div>

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

          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-fg">الاسم</span>
            <input name="customerName" required maxLength={120} value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-11 w-full rounded-[13px] border border-line bg-elevated px-3 text-sm text-fg transition-colors focus:border-[rgb(var(--brand-primary))] focus:outline-none" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-fg">رقم الهاتف</span>
            <input name="customerPhone" required maxLength={32} dir="ltr" value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="h-11 w-full rounded-[13px] border border-line bg-elevated px-3 text-sm text-fg transition-colors focus:border-[rgb(var(--brand-primary))] focus:outline-none" />
          </label>

          {fulfillment === 'delivery' ? (
            <>
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-fg">العنوان</span>
                <input name="address" required maxLength={500}
                  className="h-11 w-full rounded-[13px] border border-line bg-elevated px-3 text-sm text-fg transition-colors focus:border-[rgb(var(--brand-primary))] focus:outline-none" />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold text-fg">المدينة</span>
                  <input name="city" maxLength={120}
                    className="h-11 w-full rounded-[13px] border border-line bg-elevated px-3 text-sm text-fg transition-colors focus:border-[rgb(var(--brand-primary))] focus:outline-none" />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold text-fg">المنطقة</span>
                  <input name="area" maxLength={120}
                    className="h-11 w-full rounded-[13px] border border-line bg-elevated px-3 text-sm text-fg transition-colors focus:border-[rgb(var(--brand-primary))] focus:outline-none" />
                </label>
              </div>
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-fg">علامة مميزة</span>
                <input name="landmark" maxLength={240}
                  className="h-11 w-full rounded-[13px] border border-line bg-elevated px-3 text-sm text-fg transition-colors focus:border-[rgb(var(--brand-primary))] focus:outline-none" />
              </label>
            </>
          ) : null}

          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-fg">ملاحظات</span>
            <input name="note" maxLength={500}
              className="h-11 w-full rounded-[13px] border border-line bg-elevated px-3 text-sm text-fg transition-colors focus:border-[rgb(var(--brand-primary))] focus:outline-none" />
          </label>

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
              className="h-12 w-full rounded-[13px] bg-[rgb(var(--brand-primary))] text-base font-extrabold text-white transition-colors hover:bg-[rgb(var(--brand-primary)/0.9)] disabled:opacity-50"
            >
              {isSubmitting ? 'جارٍ إرسال الطلب…' : 'تأكيد الطلب (الدفع نقدًا)'}
            </button>
          ) : null}
          <p className="text-center text-xs text-muted">
            الدفع نقدًا عند الاستلام. الأسعار تُحسب على الخادم.
          </p>
        </form>
      </section>

      {/* Mobile only: a sticky bottom bar standing in for the cart panel,
          which is off-screen below the menu on a phone. Opens the same
          panel as an overlay rather than making checkout something to
          scroll all the way down to find. */}
      {!mobileCartOpen && (
        <button
          type="button"
          onClick={() => setMobileCartOpen(true)}
          className="fixed inset-x-0 bottom-0 z-20 flex min-h-14 items-center justify-between gap-3 bg-[rgb(var(--brand-primary))] px-5 py-3 text-white shadow-[0_-4px_12px_rgb(0_0_0/0.15)] lg:hidden"
        >
          <span className="text-sm font-semibold">
            {itemCount > 0 ? `عرض السلة (${itemCount})` : 'عرض السلة'}
          </span>
          {quote && (
            <span className="lb-numeric text-base font-extrabold">
              {money(quote.totalCents, quote.currency)}
            </span>
          )}
        </button>
      )}
    </div>
  );
}

/** A small fallback icon for a variant with no photo — a plate outline. */
function ItemThumbFallback() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      className="h-6 w-6"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm0 13 5-6 3 3 4-5 5 6"
      />
    </svg>
  );
}

/**
 * One menu item, as a compact strip row: a small thumbnail, name/description/
 * price, and an add control — replacing the large square-image card grid this
 * used to be. A row with no modifiers adds straight to the cart in one tap;
 * one with modifiers expands the picker inline instead of opening anything
 * else, so the strip stays scannable and only the item actually being
 * customised grows.
 */
function MenuRow({
  item, groups, currency, onAdd,
}: {
  item: MenuItem;
  groups: ModifierGroup[];
  currency: string;
  onAdd: (item: MenuItem, modifierIds: string[]) => void;
}) {
  const hasModifiers = groups.length > 0;
  const [expanded, setExpanded] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);

  function toggle(g: ModifierGroup, id: string) {
    const inGroup = g.modifiers.map((m) => m.id);
    const others = chosen.filter((c) => !inGroup.includes(c));
    const mine = chosen.filter((c) => inGroup.includes(c));
    if (mine.includes(id)) setChosen([...others, ...mine.filter((m) => m !== id)]);
    else if (g.maxSelect === 1) setChosen([...others, id]);
    else if (mine.length < g.maxSelect) setChosen([...others, ...mine, id]);
  }

  function handleAddClick() {
    if (!hasModifiers) { onAdd(item, []); return; }
    setExpanded((v) => !v);
  }

  function confirmAdd() {
    onAdd(item, chosen);
    setChosen([]);
    setExpanded(false);
  }

  return (
    <li className="overflow-hidden rounded-[16px] border border-line bg-elevated">
      <div className="flex items-center gap-3 p-2.5">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-[12px] bg-surface text-muted/40">
          {item.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a Storage URL, not a build asset.
            <img
              src={item.imageUrl}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
            />
          ) : (
            <ItemThumbFallback />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-fg">
            {item.productName}
            {item.variantName !== 'default' ? (
              <span className="text-muted"> — {item.variantName}</span>
            ) : null}
          </p>
          {item.description ? (
            <p className="truncate text-xs text-muted">{item.description}</p>
          ) : null}
          <span className="text-sm font-extrabold text-fg">
            {money(item.priceCents, currency)}
          </span>
        </div>

        <button
          type="button"
          onClick={handleAddClick}
          aria-expanded={hasModifiers ? expanded : undefined}
          aria-label="أضف للسلة"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[rgb(var(--brand-primary))] text-lg font-extrabold text-white transition-colors hover:bg-[rgb(var(--brand-primary)/0.9)]"
        >
          {hasModifiers && expanded ? '−' : '+'}
        </button>
      </div>

      {hasModifiers && expanded && (
        <div className="border-t border-line p-3">
          {groups.map((g) => (
            <fieldset key={g.groupId} className="mb-2">
              <legend className="mb-1 text-xs font-semibold text-muted">
                {g.groupName}
                {g.minSelect > 0 ? <span className="text-danger"> *</span> : null}
              </legend>
              <div className="flex flex-wrap gap-1.5">
                {g.modifiers.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => toggle(g, m.id)}
                    className={cn(
                      'rounded border px-2 py-1 text-xs',
                      chosen.includes(m.id)
                        ? 'border-[rgb(var(--brand-primary))] bg-[rgb(var(--brand-primary)/0.12)] text-[rgb(var(--brand-primary))]'
                        : 'border-line text-muted',
                    )}
                  >
                    {m.name}
                    {m.priceCents > 0 ? ` +${money(m.priceCents, currency)}` : ''}
                  </button>
                ))}
              </div>
            </fieldset>
          ))}
          <button
            type="button"
            onClick={confirmAdd}
            className="mt-1 flex h-9 w-full items-center justify-center gap-1 rounded-[13px] bg-[rgb(var(--brand-primary))] text-sm font-extrabold text-white transition-colors hover:bg-[rgb(var(--brand-primary)/0.9)]"
          >
            <span aria-hidden="true">+</span> أضف للسلة
          </button>
        </div>
      )}
    </li>
  );
}
