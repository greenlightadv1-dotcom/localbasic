'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import {
  checkoutAction, sendCheckoutOtpAction, placeVerifiedOrderAction,
  quoteCartAction, toggleFavoriteAction, type CheckoutState,
} from '../../actions';
import { FULFILLMENT_LABELS, FULFILLMENT_TYPES, type Fulfillment } from '@/modules/restaurant/online/schemas';
import type { MenuItem, ModifierGroup, Quote } from '@/modules/restaurant/online/service';
import { cn } from '@/lib/cn';

type Line = { variantId: string; quantity: number; modifierIds: string[]; note?: string };

function money(cents: number, currency: string) {
  return `${(cents / 100).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ${currency}`;
}

function Submit({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="h-12 w-full rounded-lg bg-[rgb(var(--brand-primary))] text-base font-semibold text-white transition-colors hover:bg-[rgb(var(--brand-primary)/0.9)] disabled:opacity-50"
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

/**
 * Guest storefront.
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
  savedAddresses = [],
  customerName = '',
  customerPhone = '',
  customerEmail = '',
  signedIn = false,
  favoriteProductIds = [],
}: {
  orgSlug: string;
  branchSlug: string;
  items: MenuItem[];
  modifierGroups: ModifierGroup[];
  currency: string;
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
  /**
   * D3. Empty for a guest, which leaves this component on exactly the D1 path.
   * The text shown here is a label; the address that reaches the order is read
   * from the database by id, under the caller's own customer row.
   */
  savedAddresses?: { id: string; label: string; address: string; isDefault: boolean }[];
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  /** Whether a customer account is signed in. The heart toggle only ever
   *  renders for one — a guest has no favorites row to toggle. Also decides
   *  whether checkout needs an email OTP (D4): a signed-in customer's email
   *  is already verified, a guest's is not. */
  signedIn?: boolean;
  favoriteProductIds?: string[];
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

  // Returning-guest convenience: a signed-out visitor's contact details are
  // remembered locally so they never retype them on their next order — on
  // this device only, and only ever a fallback under whatever the server
  // already knows (a signed-in customer's real profile always wins, since
  // `customerName` etc. arrive non-empty in that case and the cache read
  // below is skipped). The keys are shared with the table-QR ordering flow
  // (/p/[token]), so switching between the two on one phone still remembers
  // the same name.
  const [name, setName] = useState(customerName);
  const [phone, setPhone] = useState(customerPhone);
  const [email, setEmail] = useState(customerEmail);
  useEffect(() => {
    if (signedIn) return;
    try {
      if (!name) setName(localStorage.getItem('lb-guest-name') ?? '');
      if (!phone) setPhone(localStorage.getItem('lb-guest-phone') ?? '');
      if (!email) setEmail(localStorage.getItem('lb-guest-email') ?? '');
    } catch {
      // Private browsing or a blocked store: fields just start empty.
    }
    // Only ever runs once, on mount — deliberately not re-reading on every
    // prop change, since it exists purely to fill in what the server sent
    // empty for a signed-out visitor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // D4: a guest must verify a 6-digit email code before an order places; a
  // signed-in customer already has a verified email and skips straight to
  // checkoutAction, exactly the D3 path. `otpSent` gates which field the form
  // shows next — the email field until a code goes out, then the code field —
  // and `submit` below is what decides which server action a given press of
  // the button actually reaches.
  const [otpSent, setOtpSent] = useState(false);
  async function submit(prev: CheckoutState, formData: FormData): Promise<CheckoutState> {
    if (!signedIn) {
      try {
        if (name) localStorage.setItem('lb-guest-name', name);
        if (phone) localStorage.setItem('lb-guest-phone', phone);
        if (email) localStorage.setItem('lb-guest-email', email);
      } catch {
        // Best-effort only — a blocked or full store just means these
        // fields start empty again next visit, nothing else changes.
      }
    }
    if (signedIn) return checkoutAction(prev, formData);
    if (!otpSent) {
      const result = await sendCheckoutOtpAction(prev, formData);
      if (!result?.error) setOtpSent(true);
      return result;
    }
    return placeVerifiedOrderAction(prev, formData);
  }
  const [state, action] = useFormState<CheckoutState, FormData>(submit, undefined);

  // One key per checkout attempt, so a double-click or a retry is recognised
  // server-side as the same attempt rather than a second order.
  //
  // crypto.randomUUID(), not Math.random(): presenting an existing key makes
  // the server hand back that order's tracking token, so the key is a capability
  // and has to be unguessable. The retail storefront already generates it this
  // way; this one did not.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  // '' means "type a new address". Pre-selects the customer's default.
  const [savedAddressId, setSavedAddressId] = useState(
    () => savedAddresses.find((a) => a.isDefault)?.id ?? savedAddresses[0]?.id ?? '',
  );

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

  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  const visibleItems = useMemo(
    () =>
      activeCategory === null
        ? items
        : items.filter((i) => (i.categoryId ?? '__uncategorised__') === activeCategory),
    [items, activeCategory],
  );

  const itemCount = lines.reduce((n, l) => n + l.quantity, 0);

  // Optimistic: the heart flips immediately, and the write happens in the
  // background. If it fails, the toggle is silently reverted — no error
  // banner over something this low-stakes.
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set(favoriteProductIds));

  function toggleFavorite(productId: string) {
    const wasOn = favorites.has(productId);
    setFavorites((prev) => {
      const next = new Set(prev);
      if (wasOn) next.delete(productId); else next.add(productId);
      return next;
    });
    void toggleFavoriteAction({ orgSlug, productId, on: !wasOn }).then((res) => {
      if (!res.ok) {
        setFavorites((prev) => {
          const next = new Set(prev);
          if (wasOn) next.add(productId); else next.delete(productId);
          return next;
        });
      }
    });
  }

  return (
    <div className="grid gap-8 pb-24 lg:grid-cols-[1.4fr_1fr] lg:pb-0">
      <section>
        <h2 className="mb-4 text-lg font-bold text-fg">المنيو</h2>

        {categories.length > 1 && (
          <div
            role="tablist"
            aria-label="تصنيفات المنيو"
            className="mb-4 flex flex-wrap gap-2"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeCategory === null}
              onClick={() => setActiveCategory(null)}
              className={cn(
                'flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-full px-4 text-sm font-semibold transition-colors',
                activeCategory === null
                  ? 'bg-[rgb(var(--brand-primary))] text-white'
                  : 'border border-line text-muted hover:text-fg',
              )}
            >
              الكل
            </button>
            {categories.map((c) => (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={activeCategory === c.id}
                onClick={() => setActiveCategory(c.id)}
                className={cn(
                  'flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-full px-4 text-sm font-semibold transition-colors',
                  activeCategory === c.id
                    ? 'bg-[rgb(var(--brand-primary))] text-white'
                    : 'border border-line text-muted hover:text-fg',
                )}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}

        <ul
          key={activeCategory ?? 'all'}
          className="animate-fade-in grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3"
        >
          {visibleItems.map((item) => {
            const groups = groupsByProduct.get(item.productId) ?? [];
            return (
              <li
                key={item.variantId}
                className="flex flex-col overflow-hidden rounded-xl border border-line bg-elevated shadow-sm transition-shadow hover:shadow-md"
              >
                <div className="relative aspect-square w-full shrink-0 bg-surface">
                  {item.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a Storage URL, not a build asset.
                    <img
                      src={item.imageUrl}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-muted/40">
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={1.5}
                        className="h-10 w-10"
                        aria-hidden="true"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm0 13 5-6 3 3 4-5 5 6"
                        />
                      </svg>
                    </div>
                  )}
                  {signedIn && (
                    <button
                      type="button"
                      onClick={() => toggleFavorite(item.productId)}
                      aria-pressed={favorites.has(item.productId)}
                      aria-label={favorites.has(item.productId) ? 'إزالة من المفضلة' : 'إضافة للمفضلة'}
                      className={cn(
                        'absolute end-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-bg/80 text-lg leading-none shadow-sm backdrop-blur transition-colors',
                        favorites.has(item.productId) ? 'text-danger' : 'text-muted/60 hover:text-danger',
                      )}
                    >
                      {favorites.has(item.productId) ? '♥' : '♡'}
                    </button>
                  )}
                </div>

                <div className="flex flex-1 flex-col gap-1 p-3">
                  <p className="line-clamp-1 font-semibold text-fg">
                    {item.productName}
                    {item.variantName !== 'default' ? (
                      <span className="text-muted"> — {item.variantName}</span>
                    ) : null}
                  </p>
                  {item.description ? (
                    <p className="line-clamp-2 text-xs text-muted">{item.description}</p>
                  ) : null}
                  <span className="mt-auto pt-1 font-bold text-fg">
                    {money(item.priceCents, currency)}
                  </span>

                  <AddControl item={item} groups={groups} currency={currency} onAdd={add} />
                </div>
              </li>
            );
          })}
        </ul>
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
          <h2 className="text-lg font-bold text-fg">سلتك</h2>
          <button
            type="button"
            onClick={() => setMobileCartOpen(false)}
            aria-label="إغلاق السلة"
            className="flex h-11 w-11 items-center justify-center rounded-full text-xl text-muted lg:hidden"
          >
            ✕
          </button>
        </div>

        <div className="rounded-xl border border-line bg-elevated p-4 shadow-sm">
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

        <form action={action} className="mt-4 space-y-3">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <input type="hidden" name="branchSlug" value={branchSlug} />
          <input type="hidden" name="fulfillment" value={fulfillment} />
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
          <input type="hidden" name="items" value={JSON.stringify(lines)} />
          {fulfillment === 'delivery' && savedAddressId ? (
            <input type="hidden" name="savedAddressId" value={savedAddressId} />
          ) : null}

          {state?.error ? (
            <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
              {state.error}
            </p>
          ) : null}

          {!signedIn && otpSent && !state?.error ? (
            <p className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
              تم إرسال رمز مكوّن من 6 أرقام إلى بريدك الإلكتروني.
            </p>
          ) : null}

          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-fg">الاسم</span>
            <input name="customerName" required maxLength={120} value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-11 w-full rounded-lg border border-line bg-elevated px-3 text-sm text-fg transition-colors focus:border-[rgb(var(--brand-primary))] focus:outline-none" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-fg">رقم الهاتف</span>
            <input name="customerPhone" required maxLength={32} dir="ltr" value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="h-11 w-full rounded-lg border border-line bg-elevated px-3 text-sm text-fg transition-colors focus:border-[rgb(var(--brand-primary))] focus:outline-none" />
          </label>

          {/* D4: a guest verifies the email an order is placed under; a
              signed-in customer's is already verified and needs neither
              field. The email locks once a code is sent — changing it would
              mean verifying a code against an address it was never sent to. */}
          {!signedIn ? (
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-fg">البريد الإلكتروني</span>
              <input
                name="customerEmail" type="email" required maxLength={254} dir="ltr"
                value={email} onChange={(e) => setEmail(e.target.value)} disabled={otpSent}
                className="h-11 w-full rounded-lg border border-line bg-elevated px-3 text-sm text-fg transition-colors focus:border-[rgb(var(--brand-primary))] focus:outline-none disabled:opacity-60"
              />
            </label>
          ) : null}

          {!signedIn && otpSent ? (
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-fg">
                رمز التحقق المرسل إلى بريدك
              </span>
              <input
                name="otpCode" required inputMode="numeric" pattern="\d{6}" maxLength={6} dir="ltr"
                autoFocus
                className="h-11 w-full rounded-lg border border-line bg-elevated px-3 text-center text-lg font-bold tracking-[0.5em] text-fg transition-colors focus:border-[rgb(var(--brand-primary))] focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setOtpSent(false)}
                className="mt-1.5 text-xs font-semibold text-muted hover:text-fg"
              >
                تغيير البريد الإلكتروني
              </button>
            </label>
          ) : null}

          {fulfillment === 'delivery' && savedAddresses.length > 0 ? (
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-fg">عنوان التوصيل</span>
              <select
                value={savedAddressId}
                onChange={(e) => setSavedAddressId(e.target.value)}
                className="h-11 w-full rounded-lg border border-line bg-elevated px-3 text-sm text-fg transition-colors focus:border-[rgb(var(--brand-primary))] focus:outline-none"
              >
                {savedAddresses.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label} — {a.address}
                  </option>
                ))}
                <option value="">عنوان جديد…</option>
              </select>
            </label>
          ) : null}

          {fulfillment === 'delivery' && !savedAddressId ? (
            <>
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-fg">العنوان</span>
                <input name="address" required maxLength={500}
                  className="h-11 w-full rounded-lg border border-line bg-elevated px-3 text-sm text-fg transition-colors focus:border-[rgb(var(--brand-primary))] focus:outline-none" />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold text-fg">المدينة</span>
                  <input name="city" maxLength={120}
                    className="h-11 w-full rounded-lg border border-line bg-elevated px-3 text-sm text-fg transition-colors focus:border-[rgb(var(--brand-primary))] focus:outline-none" />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold text-fg">المنطقة</span>
                  <input name="area" maxLength={120}
                    className="h-11 w-full rounded-lg border border-line bg-elevated px-3 text-sm text-fg transition-colors focus:border-[rgb(var(--brand-primary))] focus:outline-none" />
                </label>
              </div>
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-fg">علامة مميزة</span>
                <input name="landmark" maxLength={240}
                  className="h-11 w-full rounded-lg border border-line bg-elevated px-3 text-sm text-fg transition-colors focus:border-[rgb(var(--brand-primary))] focus:outline-none" />
              </label>
            </>
          ) : null}

          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-fg">ملاحظات</span>
            <input name="note" maxLength={500}
              className="h-11 w-full rounded-lg border border-line bg-elevated px-3 text-sm text-fg transition-colors focus:border-[rgb(var(--brand-primary))] focus:outline-none" />
          </label>

          {lines.length > 0 ? (
            signedIn || otpSent ? (
              <Submit label="تأكيد الطلب (الدفع نقدًا)" pendingLabel="جارٍ إرسال الطلب…" />
            ) : (
              <Submit label="إرسال رمز التحقق" pendingLabel="جارٍ الإرسال…" />
            )
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
            <span className="lb-numeric text-base font-bold">
              {money(quote.totalCents, quote.currency)}
            </span>
          )}
        </button>
      )}
    </div>
  );
}

/** Per-item modifier picker. Selection rules are re-checked on the server. */
function AddControl({
  item, groups, currency, onAdd,
}: {
  item: MenuItem;
  groups: ModifierGroup[];
  currency: string;
  onAdd: (item: MenuItem, modifierIds: string[]) => void;
}) {
  const [chosen, setChosen] = useState<string[]>([]);

  function toggle(g: ModifierGroup, id: string) {
    const inGroup = g.modifiers.map((m) => m.id);
    const others = chosen.filter((c) => !inGroup.includes(c));
    const mine = chosen.filter((c) => inGroup.includes(c));
    if (mine.includes(id)) setChosen([...others, ...mine.filter((m) => m !== id)]);
    else if (g.maxSelect === 1) setChosen([...others, id]);
    else if (mine.length < g.maxSelect) setChosen([...others, ...mine, id]);
  }

  return (
    <div className="mt-2">
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
        onClick={() => { onAdd(item, chosen); setChosen([]); }}
        className="mt-1 flex h-9 w-full items-center justify-center gap-1 rounded-lg bg-[rgb(var(--brand-primary))] text-sm font-semibold text-white transition-colors hover:bg-[rgb(var(--brand-primary)/0.9)]"
      >
        <span aria-hidden="true">+</span> أضف للسلة
      </button>
    </div>
  );
}
