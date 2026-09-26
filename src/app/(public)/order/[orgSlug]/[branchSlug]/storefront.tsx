'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useFormState, useFormStatus } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import {
  checkoutAction, quoteCartAction, toggleFavoriteAction, type CheckoutState,
} from '../../actions';
import { FULFILLMENT_LABELS, FULFILLMENT_TYPES, type Fulfillment } from '@/modules/restaurant/online/schemas';
import type { MenuItem, ModifierGroup, Quote } from '@/modules/restaurant/online/service';
import { cn } from '@/lib/cn';
import { LAVECHI_GOLD_GLOW } from '@/modules/restaurant/website/lavechi-theme';

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
      className="h-12 w-full rounded-[13px] bg-[rgb(var(--brand-primary))] text-base font-extrabold text-white transition-colors hover:bg-[rgb(var(--brand-primary)/0.9)] disabled:opacity-50"
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
  /**
   * Whether a customer account is signed in. The heart toggle only ever
   * renders for one — a guest has no favorites row to toggle. Checkout
   * itself is gated on it (0078): a signed-out visitor still browses and
   * builds a cart, but placing the order redirects to sign-in/sign-up
   * first, with the cart preserved across that round trip.
   */
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
  const router = useRouter();

  // Returning-guest convenience: a signed-out visitor's name/phone are
  // remembered locally so they are not retyped on the next visit — on this
  // device only, and only ever a fallback under whatever the server already
  // knows (a signed-in customer's real profile always wins, since
  // `customerName`/`customerPhone` arrive non-empty in that case). The keys
  // are shared with the table-QR ordering flow (/p/[token]).
  const [name, setName] = useState(customerName);
  const [phone, setPhone] = useState(customerPhone);
  useEffect(() => {
    if (signedIn) return;
    try {
      if (!name) setName(localStorage.getItem('lb-guest-name') ?? '');
      if (!phone) setPhone(localStorage.getItem('lb-guest-phone') ?? '');
    } catch {
      // Private browsing or a blocked store: fields just start empty.
    }
    // Only ever runs once, on mount — deliberately not re-reading on every
    // prop change, since it exists purely to fill in what the server sent
    // empty for a signed-out visitor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Checkout is gated on having an account (0078). A signed-out visitor still
  // browses and builds a full cart; the cart is what would otherwise be lost
  // sending them off to sign in, so it is stashed here and restored once they
  // are back — signed in, on this exact page — rather than requiring the
  // trip to remember nothing.
  const cartStorageKey = `lb-cart:${orgSlug}:${branchSlug}`;
  useEffect(() => {
    if (!signedIn) return;
    try {
      const saved = localStorage.getItem(cartStorageKey);
      if (!saved) return;
      const restored = JSON.parse(saved) as { lines: Line[]; fulfillment: Fulfillment };
      if (Array.isArray(restored.lines) && restored.lines.length > 0) {
        setLines(restored.lines);
        if (restored.fulfillment) setFulfillment(restored.fulfillment);
        repriceWith(restored.lines, restored.fulfillment ?? fulfillment);
      }
      localStorage.removeItem(cartStorageKey);
    } catch {
      // A corrupt or blocked store just means starting with an empty cart.
    }
    // Only ever runs once, right after landing back here signed in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  function goToSignIn() {
    try {
      if (lines.length > 0) {
        localStorage.setItem(cartStorageKey, JSON.stringify({ lines, fulfillment }));
      }
    } catch {
      // Best-effort only — worst case the cart is empty when they return.
    }
    const next = `/order/${orgSlug}/${branchSlug}`;
    router.push(`/r/${orgSlug}/account/sign-in?next=${encodeURIComponent(next)}`);
  }

  const [state, action] = useFormState<CheckoutState, FormData>(checkoutAction, undefined);

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
                          signedIn={signedIn}
                          isFavorite={favorites.has(item.productId)}
                          onToggleFavorite={() => toggleFavorite(item.productId)}
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
                signedIn={signedIn}
                isFavorite={favorites.has(item.productId)}
                onToggleFavorite={() => toggleFavorite(item.productId)}
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

        {!signedIn ? (
          // Checkout is gated on an account (0078) — a signed-out visitor
          // still builds a full cart, but placing the order needs a phone
          // number to place it under. goToSignIn() stashes the cart first,
          // so it is exactly as it was when they come back signed in.
          <div className="mt-4 rounded-[18px] border border-line bg-elevated p-4 text-center">
            <p className="mb-3 text-sm text-muted">
              سجّل الدخول لإتمام الطلب — رقم هاتفك هو حسابك.
            </p>
            <button
              type="button"
              onClick={goToSignIn}
              disabled={lines.length === 0}
              style={{ boxShadow: lines.length > 0 ? LAVECHI_GOLD_GLOW : undefined }}
              className="h-12 w-full rounded-[13px] bg-[rgb(var(--brand-primary))] text-base font-extrabold text-white transition-colors hover:bg-[rgb(var(--brand-primary)/0.9)] disabled:opacity-50"
            >
              تسجيل الدخول لإتمام الطلب
            </button>
          </div>
        ) : (
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
            <p className="rounded-[13px] border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
              {state.error}
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

          {fulfillment === 'delivery' && savedAddresses.length > 0 ? (
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-fg">عنوان التوصيل</span>
              <select
                value={savedAddressId}
                onChange={(e) => setSavedAddressId(e.target.value)}
                className="h-11 w-full rounded-[13px] border border-line bg-elevated px-3 text-sm text-fg transition-colors focus:border-[rgb(var(--brand-primary))] focus:outline-none"
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

          {lines.length > 0 ? (
            <Submit label="تأكيد الطلب (الدفع نقدًا)" pendingLabel="جارٍ إرسال الطلب…" />
          ) : null}
          <p className="text-center text-xs text-muted">
            الدفع نقدًا عند الاستلام. الأسعار تُحسب على الخادم.
          </p>
        </form>
        )}
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
  item, groups, currency, onAdd, signedIn, isFavorite, onToggleFavorite,
}: {
  item: MenuItem;
  groups: ModifierGroup[];
  currency: string;
  onAdd: (item: MenuItem, modifierIds: string[]) => void;
  signedIn: boolean;
  isFavorite: boolean;
  onToggleFavorite: () => void;
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

        {signedIn && (
          <button
            type="button"
            onClick={onToggleFavorite}
            aria-pressed={isFavorite}
            aria-label={isFavorite ? 'إزالة من المفضلة' : 'إضافة للمفضلة'}
            className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center text-lg leading-none transition-colors',
              isFavorite ? 'text-danger' : 'text-muted/60 hover:text-danger',
            )}
          >
            {isFavorite ? '♥' : '♡'}
          </button>
        )}

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
