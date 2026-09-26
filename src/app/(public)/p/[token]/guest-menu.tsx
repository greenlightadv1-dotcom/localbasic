'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, ImageOff, Minus, Plus, ShoppingBag, X, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/cn';
import { PoweredBy } from '@/components/brand/logo';
import { LAVECHI_CARD_SHADOW, LAVECHI_SHEET_SPRING } from '@/modules/restaurant/website/lavechi-theme';
import { usePrefersReducedMotion } from '@/modules/restaurant/website/lavechi-theme-client';
import type {
  PublicCategory,
  PublicContext,
  PublicProduct,
  PublicVariant,
} from '@/modules/restaurant/public/service';
import { placeGuestOrderAction } from './actions';

/** A bottom sheet: springs up from off-screen, slides back down on close. */
function Sheet({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const reduced = usePrefersReducedMotion();
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="fixed inset-0 z-40 flex flex-col justify-end bg-black/40"
      onClick={onClose}
    >
      <motion.div
        initial={reduced ? { y: 0 } : { y: '100%' }}
        animate={{ y: 0 }}
        exit={reduced ? { y: 0 } : { y: '100%' }}
        transition={reduced ? { duration: 0 } : LAVECHI_SHEET_SPRING}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85dvh] overflow-y-auto rounded-t-[22px] bg-elevated p-4"
        style={{ boxShadow: LAVECHI_CARD_SHADOW }}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

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
}: {
  token: string;
  context: PublicContext;
  menu: PublicCategory[];
}) {
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [picking, setPicking] = useState<{ product: PublicProduct; variant: PublicVariant } | null>(
    null,
  );
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [guestName, setGuestName] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  // Returning-guest convenience only: prefills the name field from whichever
  // table this browser last ordered at (or the online storefront, since both
  // share the same key). Never trusted for anything — the order still stores
  // whatever the field holds at submit time, exactly like a first-time guest.
  useEffect(() => {
    try {
      const cached = localStorage.getItem('lb-guest-name');
      if (cached) setGuestName(cached);
    } catch {
      // Private browsing or a blocked store: the field just starts empty.
    }
  }, []);

  // Categories start collapsed except the first — a screen with every
  // category's items open at once is exactly the clutter this replaces.
  // Searching overrides collapse entirely: a matching category always shows
  // its matches, never buried behind a tap the search bar already implied.
  const [openCategories, setOpenCategories] = useState<Set<string>>(
    () => new Set(menu[0] ? [menu[0].id] : []),
  );
  function toggleCategory(id: string) {
    setOpenCategories((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return menu;
    return menu
      .map((category) => ({
        ...category,
        products: category.products.filter(
          (p) =>
            p.name.toLowerCase().includes(term) ||
            (p.description ?? '').toLowerCase().includes(term),
        ),
      }))
      .filter((category) => category.products.length > 0);
  }, [menu, search]);

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

  function submit() {
    if (cart.length === 0) return;
    setError(null);
    startTransition(async () => {
      const result = await placeGuestOrderAction({
        token,
        items: cart.map((l) => ({
          variantId: l.variant.id,
          quantity: l.quantity,
          modifierIds: l.modifiers.map((m) => m.id),
        })),
        guestName: guestName || undefined,
        note: note || undefined,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }
      try {
        if (guestName) localStorage.setItem('lb-guest-name', guestName);
      } catch {
        // Best-effort convenience only — a blocked or full store just means
        // the name field starts empty next visit, nothing else changes.
      }
      // Same tracking page and live realtime status an online order gets
      // (0076) — the guest never sees a dead-end "order received" screen.
      router.push(`/order/track/${result.data.statusToken}`);
    });
  }

  return (
    <main className="mx-auto max-w-2xl pb-28">
      <header className="sticky top-0 z-20 border-b border-line bg-elevated/70 px-4 py-3 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <span className="relative inline-flex shrink-0">
            {context.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={context.logoUrl}
                alt=""
                className="lavechi-ring-pulse h-10 w-10 rounded-full object-cover"
              />
            ) : (
              <span className="lavechi-ring-pulse flex h-10 w-10 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-fg">
                {context.organizationName.slice(0, 2)}
              </span>
            )}
            <span aria-hidden className="lavechi-steam pointer-events-none absolute -top-2 start-1/2 -translate-x-1/2">
              <span className="absolute block h-3 w-1 -translate-x-2 rounded-full bg-[#F4F1E4]/40 blur-[1px]" />
              <span className="absolute block h-3 w-1 rounded-full bg-[#F4F1E4]/40 blur-[1px]" />
              <span className="absolute block h-3 w-1 translate-x-2 rounded-full bg-[#F4F1E4]/40 blur-[1px]" />
            </span>
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-reem text-lg font-normal tracking-wide text-fg">
              {context.organizationName}
            </h1>
            <p className="text-xs text-muted">
              {context.branchName} · طاولة {context.tableName}
            </p>
          </div>
        </div>

        <div className="relative mt-3">
          <Search
            className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-muted"
            aria-hidden="true"
          />
          <label htmlFor="guest-search" className="sr-only">
            ابحث في المنيو
          </label>
          <Input
            id="guest-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="ابحث في المنيو…"
            className="ps-9"
          />
        </div>
      </header>

      {!context.orderingEnabled && (
        <div className="px-4 pt-4">
          <Alert tone="info">هذا المنيو للعرض فقط. اطلب من الكابتن.</Alert>
        </div>
      )}

      {filtered.length === 0 ? (
        <p className="px-4 py-16 text-center text-sm text-muted">لا توجد أصناف مطابقة.</p>
      ) : (
        <div className="space-y-3 px-4 py-4">
          {filtered.map((category) => {
            const isOpen = Boolean(search.trim()) || openCategories.has(category.id);
            return (
            <section
              key={category.id}
              className="overflow-hidden rounded-[18px] border border-line bg-elevated"
              style={{ boxShadow: LAVECHI_CARD_SHADOW }}
            >
              <button
                type="button"
                onClick={() => toggleCategory(category.id)}
                aria-expanded={isOpen}
                aria-controls={`cat-${category.id}`}
                className="flex min-h-12 w-full items-center justify-between gap-2 px-3 py-3 text-start"
              >
                <span className="text-base font-bold">{category.name}</span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-muted">
                  <span className="lb-numeric">{category.products.length}</span>
                  <ChevronDown
                    className={cn('h-4 w-4 transition-transform', isOpen && 'rotate-180')}
                    aria-hidden="true"
                  />
                </span>
              </button>
              {isOpen && (
              <div id={`cat-${category.id}`} className="border-t border-line p-3 pt-2">
              {category.description && (
                <p className="mb-2 text-sm text-muted">{category.description}</p>
              )}
              <ul className="space-y-2">
                {category.products.map((product) => (
                  <li key={product.id} className="rounded-[13px] bg-surface p-2.5">
                    <div className="flex gap-3">
                      <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-[12px] bg-elevated text-muted/40">
                        {product.image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={product.image_url}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <ImageOff className="h-5 w-5" aria-hidden="true" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold">{product.name}</p>
                        {product.description && (
                          <p className="mt-0.5 line-clamp-2 text-sm text-muted">
                            {product.description}
                          </p>
                        )}
                        <ul className="mt-2 flex flex-wrap gap-2">
                          {product.variants.map((variant) => (
                            <li key={variant.id}>
                              <button
                                type="button"
                                disabled={!variant.available || !context.orderingEnabled}
                                onClick={() => choose(product, variant)}
                                className={cn(
                                  'flex min-h-11 items-center gap-2 rounded-[13px] border px-3 text-sm font-extrabold transition-colors',
                                  variant.available && context.orderingEnabled
                                    ? 'border-primary/30 bg-primary-soft text-primary active:bg-primary active:text-primary-fg'
                                    : 'cursor-not-allowed border-line bg-surface text-muted',
                                )}
                              >
                                {variant.name !== 'default' && <span>{variant.name}</span>}
                                <span className="lb-numeric">
                                  {formatMoney(variant.price_cents, context.currency)}
                                </span>
                                {!variant.available && <Badge tone="danger">نفد</Badge>}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
              </div>
              )}
            </section>
            );
          })}
        </div>
      )}

      {!context.whiteLabel && (
        <div className="px-4 pb-6 pt-2 text-center">
          <PoweredBy />
        </div>
      )}

      {/* Cart bar */}
      {cartCount > 0 && context.orderingEnabled && !cartOpen && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-elevated p-3">
          <Button size="touch" block onClick={() => setCartOpen(true)}>
            <ShoppingBag className="h-5 w-5" aria-hidden="true" />
            <span>عرض الطلب ({cartCount})</span>
            <span className="lb-numeric ms-auto">{formatMoney(cartTotal, context.currency)}</span>
          </Button>
        </div>
      )}

      {/* Cart sheet */}
      <AnimatePresence>
        {cartOpen && (
          <Sheet onClose={() => setCartOpen(false)}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-reem text-lg font-normal tracking-wide">طلبك</h2>
              <button
                type="button"
                onClick={() => setCartOpen(false)}
                aria-label="إغلاق"
                className="flex h-9 w-9 items-center justify-center rounded-[12px] border border-line"
              >
                <X className="h-5 w-5 text-muted" />
              </button>
            </div>

            {error && <Alert tone="danger" className="mb-3">{error}</Alert>}

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
                      {formatMoney(
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
                <label htmlFor="guest-name" className="mb-1 block text-sm font-medium">
                  الاسم (اختياري)
                </label>
                <Input
                  id="guest-name"
                  value={guestName}
                  onChange={(e) => setGuestName(e.target.value)}
                  maxLength={80}
                />
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
                <span className="lb-numeric">{formatMoney(cartTotal, context.currency)}</span>
              </div>
              <p className="text-xs text-muted">
                الإجمالي النهائي يُحتسب من المطعم وقد يشمل الضريبة والخدمة.
              </p>

              <Button size="touch" block disabled={isPending} onClick={submit}>
                {isPending ? 'جارٍ الإرسال…' : 'إرسال الطلب'}
              </Button>
            </div>
          </Sheet>
        )}
      </AnimatePresence>

      {/* Modifier sheet */}
      <AnimatePresence>
        {picking && (
          <Sheet onClose={() => setPicking(null)}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-reem text-lg font-normal tracking-wide">{picking.product.name}</h2>
              <button
                type="button"
                onClick={() => setPicking(null)}
                aria-label="إغلاق"
                className="flex h-9 w-9 items-center justify-center rounded-[12px] border border-line"
              >
                <X className="h-5 w-5 text-muted" />
              </button>
            </div>

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
                              +{formatMoney(modifier.price_cents, context.currency)}
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
          </Sheet>
        )}
      </AnimatePresence>
    </main>
  );
}
