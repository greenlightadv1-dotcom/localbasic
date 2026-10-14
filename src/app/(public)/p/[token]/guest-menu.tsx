'use client';

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { Minus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { cn } from '@/lib/cn';
import { PoweredBy } from '@/components/brand/logo';
import {
  BottomSheet, CartBar, CategorySection, FoodCard, FoodGrid, StoreHeader,
} from '@/components/menu/food-ui';
import type {
  PublicCategory,
  PublicContext,
  PublicProduct,
  PublicVariant,
} from '@/modules/restaurant/public/service';
import { getDeviceId } from '@/modules/restaurant/guest-verification/device';
import { getBrowserLocation } from '@/modules/restaurant/guest-verification/geolocation';
import { CustomerProfileSheet, ProfileHeaderButton, StoreBottomNav, useGuestSnapshot, useProfileSheet } from '@/components/menu/customer-profile';
import { StoreToaster } from '@/components/menu/store-toast';
import { LiquidTransitions, StoreSplash } from '@/components/menu/liquid';
import { MenuFilterBar } from '@/components/menu/menu-filter-bar';
import { useMenuFilter } from '@/components/menu/menu-filter';
import { loyaltyPerk, type LoyaltyPublic } from '@/modules/restaurant/customer/perk';
import { formatPrice } from '@/lib/price';
import type { ReorderLine } from '@/modules/restaurant/customer/types';
import { OrderStatusBanner, rememberActiveOrder } from '@/components/menu/order-status-banner';
import { PaymentOptionsList } from '@/components/menu/payment-options';
import type { PaymentOptions } from '@/modules/restaurant/payments/options';
import { GuestVerifySheet } from '@/modules/restaurant/guest-verification/verify-sheet';
import { usePendingVerification } from '@/modules/restaurant/guest-verification/use-pending-verification';
import { placeGuestOrderAction, getOrderVerificationInfoAction } from './actions';

type CartLine = {
  key: string;
  productName: string;
  variant: PublicVariant;
  modifiers: { id: string; name: string; price_cents: number }[];
  quantity: number;
  note?: string;
};

/**
 * The guest experience: scan, read, order.
 *
 * Mobile-first and deliberately small — a phone held one-handed at a table,
 * often on a slow connection. The menu arrives with the page, so browsing costs
 * no further requests, and the only round trip is placing the order.
 *
 * Prices shown here are for reading. The order sends item ids and quantities
 * only; the server prices everything from the database.
 */
export function GuestMenu({
  token,
  context,
  menu,
  paymentOptions,
  loyalty,
}: {
  token: string;
  context: PublicContext;
  menu: PublicCategory[];
  paymentOptions: PaymentOptions;
  loyalty: LoyaltyPublic | null;
}) {
  const [cart, setCart] = useState<CartLine[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [picking, setPicking] = useState<{ product: PublicProduct; variant: PublicVariant } | null>(
    null,
  );
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  // A product with several sizes asks which one before anything else.
  const [choosingVariant, setChoosingVariant] = useState<PublicProduct | null>(null);
  const [guestName, setGuestName] = useState('');
  const [guestPhone, setGuestPhone] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [deviceId, setDeviceId] = useState('');
  // null: order not placed yet, or already verified and on its way to
  // tracking. Set once a placed order comes back 'pending_verification' —
  // cleared the moment realtime (or a manual recheck) reports it's past that.

  /** Past verification: stay on the menu and pin the live status banner. */
  function finishOrder(orderToken: string) {
    setCart([]);
    setNote('');
    setCartOpen(false);
    rememberActiveOrder(`table/${token}`, orderToken);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Survives a refresh or a return from WhatsApp: restores the pending order,
  // re-checks on return to the tab, polls gently, and listens on realtime.
  const verify = usePendingVerification({
    scopeKey: `table/${token}`,
    check: getOrderVerificationInfoAction,
    onConfirmed: finishOrder,
  });
  const verification = verify.pending;

  const loadStatus = useCallback(async (orderToken: string) => {
    const info = await getOrderVerificationInfoAction(orderToken);
    return info.ok ? info.data.status : null;
  }, []);

  // ---- guest profile: reorder -------------------------------------------
  const profileSheet = useProfileSheet();
  const snapshot = useGuestSnapshot({ kind: 'token', token });

  /** Adds a past order's lines to the cart; unavailable items are skipped. */
  function reorder(past: ReorderLine[]): { added: number; skipped: number } {
    let added = 0;
    let skipped = 0;
    const additions: CartLine[] = [];
    for (const l of past) {
      let found: { product: PublicProduct; variant: PublicVariant } | null = null;
      for (const c of menu) {
        for (const p of c.products) {
          const v = p.variants.find((x) => x.id === l.variantId);
          if (v) found = { product: p, variant: v };
        }
      }
      if (!found || !found.variant.available) { skipped += 1; continue; }
      const known = new Map(found.product.modifier_groups.flatMap((g) => g.modifiers.map((m) => [m.id, m] as const)));
      const modifiers = l.modifierIds.flatMap((id) => {
        const m = known.get(id);
        return m ? [{ id: m.id, name: m.name, price_cents: m.price_cents }] : [];
      });
      additions.push({
        key: `${found.variant.id}:${modifiers.map((m) => m.id).sort().join(',')}`,
        productName: found.product.name,
        variant: found.variant,
        modifiers,
        quantity: l.quantity,
        note: l.note ?? undefined,
      });
      added += 1;
    }
    if (added > 0) {
      setCart((lines) => {
        const next = [...lines];
        for (const a of additions) {
          const at = next.findIndex((x) => x.key === a.key);
          if (at >= 0) next[at] = { ...next[at]!, quantity: next[at]!.quantity + a.quantity };
          else next.push(a);
        }
        return next;
      });
    }
    return { added, skipped };
  }

  // Returning-guest convenience only: prefills the name/phone fields from
  // whichever table this browser last ordered at (or the online storefront,
  // since both share the same keys). Never trusted for anything — the order
  // still stores whatever the fields hold at submit time, exactly like a
  // first-time guest.
  useEffect(() => {
    setDeviceId(getDeviceId());
    try {
      const cachedName = localStorage.getItem('lb-guest-name');
      if (cachedName) setGuestName(cachedName);
      const cachedPhone = localStorage.getItem('lb-guest-phone');
      if (cachedPhone) setGuestPhone(cachedPhone);
    } catch {
      // Private browsing or a blocked store: the fields just start empty.
    }
  }, []);

  const sections = useMemo(
    () =>
      menu.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        imageUrl: c.image_url ?? c.products.find((p) => p.image_url)?.image_url ?? null,
        items: c.products,
      })),
    [menu],
  );
  const filter = useMenuFilter(sections, (p: PublicProduct) => `${p.name} ${p.description ?? ''}`);

  const cartCount = cart.reduce((sum, l) => sum + l.quantity, 0);
  const cartTotal = cart.reduce(
    (sum, l) =>
      sum +
      Math.round(
        (l.variant.price_cents + l.modifiers.reduce((s, m) => s + m.price_cents, 0)) * l.quantity,
      ),
    0,
  );

  function choose(product: PublicProduct, variant: PublicVariant) {
    if (!variant.available) return;
    if (product.modifier_groups.length === 0) {
      addLine(product, variant, []);
      return;
    }
    setChosen({});
    setError(null);
    setPicking({ product, variant });
  }

  function addLine(
    product: PublicProduct,
    variant: PublicVariant,
    modifiers: { id: string; name: string; price_cents: number }[],
  ) {
    const key = `${variant.id}:${modifiers.map((m) => m.id).sort().join(',')}`;
    setCart((lines) => {
      const existing = lines.find((l) => l.key === key);
      if (existing) {
        return lines.map((l) => (l.key === key ? { ...l, quantity: l.quantity + 1 } : l));
      }
      return [...lines, { key, productName: product.name, variant, modifiers, quantity: 1 }];
    });
  }

  function confirmModifiers() {
    if (!picking) return;
    for (const group of picking.product.modifier_groups) {
      const picked = chosen[group.id] ?? [];
      if (picked.length < group.min_select || picked.length > group.max_select) {
        setError(`اختر من ${group.min_select} إلى ${group.max_select} من «${group.name}»`);
        return;
      }
    }
    const modifiers = picking.product.modifier_groups.flatMap((g) =>
      (chosen[g.id] ?? []).map((id) => g.modifiers.find((m) => m.id === id)!),
    );
    addLine(picking.product, picking.variant, modifiers);
    setPicking(null);
    setError(null);
  }

  /**
   * The order always gets placed — a phone-less guest or an already-trusted
   * device/phone pair just starts at 'new' server-side. Only a first-time
   * device+phone pair comes back 'pending_verification', in which case the
   * WhatsApp sheet takes over and realtime (or a manual recheck) advances
   * from there.
   */
  function submit() {
    if (cart.length === 0) return;
    setError(null);
    // Name and phone are the whole identity (and what the WhatsApp check binds to).
    if (guestName.trim().length < 2) { setError('اكتب اسمك.'); return; }
    if (guestPhone.trim().length < 6) { setError('اكتب رقم هاتفك لتأكيد الطلب على واتساب.'); return; }
    startTransition(async () => {
      const location = await getBrowserLocation();
      const result = await placeGuestOrderAction({
        token,
        items: cart.map((l) => ({
          variantId: l.variant.id,
          quantity: l.quantity,
          modifierIds: l.modifiers.map((m) => m.id),
        })),
        guestName: guestName.trim(),
        guestPhone: guestPhone.trim(),
        note: note || undefined,
        deviceId: deviceId || undefined,
        latitude: location?.latitude,
        longitude: location?.longitude,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }
      try {
        if (guestName) localStorage.setItem('lb-guest-name', guestName);
        if (guestPhone) localStorage.setItem('lb-guest-phone', guestPhone);
      } catch {
        // Best-effort convenience only — a blocked or full store just means
        // the fields start empty next visit, nothing else changes.
      }

      const info = await getOrderVerificationInfoAction(result.data.statusToken);
      if (verify.begin(result.data.statusToken, info.ok ? info.data : null)) return;
      // Same tracking page and live realtime status an online order gets
      // (0076) — the guest never sees a dead-end "order received" screen.
      finishOrder(result.data.statusToken);
    });
  }



  /** Quick add: one size adds straight away; several sizes ask which. */
  function quickAdd(product: PublicProduct) {
    const available = product.variants.filter((v) => v.available);
    if (available.length === 0) return;
    if (product.variants.length === 1 || available.length === 1) {
      choose(product, available[0]!);
      return;
    }
    setChoosingVariant(product);
  }
  const inCart = (product: PublicProduct) =>
    cart.filter((l) => product.variants.some((v) => v.id === l.variant.id)).reduce((n, l) => n + l.quantity, 0);
  const fromPrice = (product: PublicProduct) => Math.min(...product.variants.map((v) => v.price_cents));

  return (
    <main className="mx-auto max-w-2xl pb-40">
      <OrderStatusBanner scopeKey={`table/${token}`} loadStatus={loadStatus} />
      <StoreToaster />
      <LiquidTransitions />
      <StoreSplash scopeKey={`table/${token}`} name={context.organizationName} logoUrl={context.logoUrl} tagline={`${context.branchName} · طاولة ${context.tableName}`} />
      <StoreBottomNav cartCount={cartCount} onCart={() => context.orderingEnabled && setCartOpen(true)} />
      {profileSheet.open ? (
        <CustomerProfileSheet
          scope={{ kind: 'token', token }}
          onClose={() => profileSheet.setOpen(false)}
          initial={snapshot.profile}
          onReorder={reorder}
          onOpenCart={() => context.orderingEnabled && setCartOpen(true)}
        />
      ) : null}
      <StoreHeader
        name={context.organizationName}
        logoUrl={context.logoUrl}
        chips={[context.branchName, `طاولة ${context.tableName}`]}
        action={<ProfileHeaderButton />}
      />

      <MenuFilterBar
        categories={sections.map((c) => ({ id: c.id, name: c.name }))}
        selected={filter.selected} onSelect={filter.setSelected}
        query={filter.query} onQuery={filter.setQuery}
        resultCount={filter.count} filtering={filter.filtering} onClear={filter.clear}
      />

      {!context.orderingEnabled && (
        <div className="px-4 pb-2">
          <Alert tone="info">هذا المنيو للعرض فقط. اطلب من الكابتن.</Alert>
        </div>
      )}

      {filter.visible.map((category) => (
          <CategorySection key={`${filter.selected}:${category.id}`} id={category.id} name={category.name} description={category.description}>
            <FoodGrid>
              {category.items.map((product) => (
                <FoodCard
                  key={product.id}
                  name={product.name}
                  description={product.description}
                  priceLabel={`${product.variants.length > 1 ? 'من ' : ''}${formatPrice(fromPrice(product), context.currency)}`}
                  imageUrl={product.image_url}
                  categoryName={category.name}
                  soldOut={product.variants.every((v) => !v.available)}
                  canOrder={context.orderingEnabled}
                  count={inCart(product)}
                  onAdd={() => quickAdd(product)}
                />
              ))}
            </FoodGrid>
          </CategorySection>
      ))}

      {!context.whiteLabel && (
        <div className="px-4 pb-6 pt-6 text-center">
          <PoweredBy />
        </div>
      )}

      {/* Cart bar */}
      {context.orderingEnabled && !cartOpen && (
        <CartBar
          count={cartCount}
          totalLabel={formatPrice(cartTotal, context.currency)}
          onClick={() => setCartOpen(true)}
          label="عرض الطلب"
          perk={loyaltyPerk({
            cartCents: cartTotal,
            loyalty,
            balance: snapshot.profile?.verified ? snapshot.profile.loyalty.balance : null,
          })}
        />
      )}

      {/* Cart sheet */}
      {cartOpen && (
          <BottomSheet title="طلبك" onClose={() => setCartOpen(false)}>

            {error && !verification && <Alert tone="danger" className="mb-3">{error}</Alert>}

            <ul className="space-y-2">
              {cart.map((line) => (
                <li key={line.key} className="rounded border border-line p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium">{line.productName}</p>
                      {line.variant.name !== 'default' && (
                        <p className="text-xs text-muted">{line.variant.name}</p>
                      )}
                      {line.modifiers.length > 0 && (
                        <p className="text-xs text-muted">
                          {line.modifiers.map((m) => m.name).join('، ')}
                        </p>
                      )}
                    </div>
                    <span className="lb-numeric font-semibold">
                      {formatPrice(
                        Math.round(
                          (line.variant.price_cents +
                            line.modifiers.reduce((s, m) => s + m.price_cents, 0)) *
                            line.quantity,
                        ),
                        context.currency,
                      )}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
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
                    <span className="lb-numeric w-8 text-center font-semibold">{line.quantity}</span>
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
                </li>
              ))}
            </ul>

            <div className="mt-4 space-y-3">
              <div>
                <label htmlFor="guest-name" className="mb-1 block text-sm font-semibold">
                  الاسم
                </label>
                <Input
                  id="guest-name"
                  value={guestName}
                  onChange={(e) => setGuestName(e.target.value)}
                  maxLength={80}
                  required
                  autoComplete="name"
                  className="h-12 rounded-[14px]"
                />
              </div>
              <div>
                <label htmlFor="guest-phone" className="mb-1 block text-sm font-semibold">
                  رقم الهاتف
                </label>
                <Input
                  id="guest-phone"
                  type="tel"
                  inputMode="tel"
                  dir="ltr"
                  value={guestPhone}
                  onChange={(e) => setGuestPhone(e.target.value)}
                  maxLength={32}
                  required
                  autoComplete="tel"
                  className="h-12 rounded-[14px]"
                />
                <p className="mt-1 text-xs text-muted">لتأكيد طلبك على واتساب. لا حاجة لحساب أو كلمة مرور.</p>
              </div>
              <div>
                <label htmlFor="guest-note" className="mb-1 block text-sm font-medium">
                  ملاحظات (اختياري)
                </label>
                <Textarea
                  id="guest-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={300}
                  className="min-h-16"
                />
              </div>

              <div className="flex justify-between border-t border-line pt-3 text-base font-bold">
                <span>الإجمالي</span>
                <span className="lb-numeric">{formatPrice(cartTotal, context.currency)}</span>
              </div>
              <p className="text-xs text-muted">
                الإجمالي النهائي يُحتسب من المطعم وقد يشمل الضريبة والخدمة.
              </p>

              <PaymentOptionsList options={paymentOptions} />

              {verification ? (
                <GuestVerifySheet
                  code={verification.code}
                  whatsappUrl={verification.whatsappUrl}
                  checking={verify.checking}
                  error={verify.error}
                  expired={verify.expired}
                  onRecheck={verify.recheck}
                />
              ) : (
                <Button size="touch" block disabled={isPending} onClick={submit}>
                  {isPending ? 'جارٍ الإرسال…' : 'إرسال الطلب'}
                </Button>
              )}
            </div>
          </BottomSheet>
        )}

      {/* Size picker — only for a product with more than one size */}
      {choosingVariant && (
        <BottomSheet title={choosingVariant.name} onClose={() => setChoosingVariant(null)}>
          <ul className="space-y-2">
            {choosingVariant.variants.map((variant) => (
              <li key={variant.id}>
                <button
                  type="button"
                  disabled={!variant.available}
                  onClick={() => {
                    const product = choosingVariant;
                    setChoosingVariant(null);
                    choose(product, variant);
                  }}
                  className={cn(
                    'flex min-h-14 w-full items-center justify-between gap-3 rounded-[14px] border px-4 text-base font-bold transition-colors',
                    variant.available
                      ? 'border-line bg-elevated text-fg active:border-primary active:bg-primary-soft'
                      : 'cursor-not-allowed border-line bg-surface text-muted',
                  )}
                >
                  <span>{variant.name !== 'default' ? variant.name : choosingVariant.name}</span>
                  <span className="lb-numeric text-primary">
                    {variant.available ? formatPrice(variant.price_cents, context.currency) : 'نفد'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </BottomSheet>
      )}

      {/* Modifier sheet */}
      {picking && (
          <BottomSheet title={picking.product.name} onClose={() => setPicking(null)}>

            {error && <Alert tone="danger" className="mb-3">{error}</Alert>}

            <div className="space-y-4">
              {picking.product.modifier_groups.map((group) => (
                <fieldset key={group.id}>
                  <legend className="mb-2 text-sm font-semibold">
                    {group.name}
                    <span className="ms-2 text-xs font-normal text-muted">
                      {group.min_select > 0 ? 'مطلوب' : 'اختياري'}
                      {group.max_select > 1 && ` · حتى ${group.max_select}`}
                    </span>
                  </legend>
                  <div className="space-y-1.5">
                    {group.modifiers.map((modifier) => {
                      const picked = (chosen[group.id] ?? []).includes(modifier.id);
                      const single = group.max_select === 1;
                      return (
                        <label
                          key={modifier.id}
                          className={cn(
                            'flex min-h-12 cursor-pointer items-center justify-between gap-2 rounded border px-3 text-sm',
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
                                      : [...current, modifier.id].slice(0, group.max_select),
                                  };
                                })
                              }
                              className="h-4 w-4"
                            />
                            {modifier.name}
                          </span>
                          {modifier.price_cents > 0 && (
                            <span className="lb-numeric text-muted">
                              +{formatPrice(modifier.price_cents, context.currency)}
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              ))}
            </div>

            <Button size="touch" block className="mt-4" onClick={confirmModifiers}>
              إضافة للطلب
            </Button>
          </BottomSheet>
        )}
    </main>
  );
}
