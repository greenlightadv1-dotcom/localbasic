'use client';

import { useMemo, useState, useTransition } from 'react';
import { Minus, Plus, ShoppingBag, Check, X, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/cn';
import { PoweredBy } from '@/components/brand/logo';
import type {
  PublicCategory,
  PublicContext,
  PublicProduct,
  PublicVariant,
} from '@/modules/restaurant/public/service';
import { placeGuestOrderAction } from './actions';

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
  const [placed, setPlaced] = useState<{ number: string; total: number } | null>(null);
  const [isPending, startTransition] = useTransition();

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
      setPlaced({ number: result.data.orderNumber, total: result.data.totalCents });
      setCart([]);
      setCartOpen(false);
    });
  }

  if (placed) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-5 px-5 text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-success/10">
          <Check className="h-8 w-8 text-success" aria-hidden="true" />
        </span>
        <div className="space-y-1">
          <h1 className="text-xl font-bold">تم استلام طلبك</h1>
          <p className="text-sm text-muted">
            طاولة {context.tableName} · سيصلك الطلب قريبًا بإذن الله.
          </p>
        </div>
        <dl className="w-full space-y-2 rounded-lg border border-line bg-elevated p-4 text-start">
          <div className="flex justify-between">
            <dt className="text-muted">رقم الطلب</dt>
            <dd className="lb-numeric font-bold">#{placed.number}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">الإجمالي</dt>
            <dd className="lb-numeric font-bold">{formatMoney(placed.total, context.currency)}</dd>
          </div>
        </dl>
        <p className="text-xs text-muted">الدفع عند الكاشير أو مع الكابتن.</p>
        <Button variant="outline" block onClick={() => setPlaced(null)}>
          اطلب المزيد
        </Button>
        {!context.whiteLabel && <PoweredBy className="mt-4" />}
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl pb-28">
      <header className="sticky top-0 z-20 border-b border-line bg-elevated/95 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          {context.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={context.logoUrl} alt="" className="h-10 w-10 rounded object-contain" />
          ) : (
            <span className="flex h-10 w-10 items-center justify-center rounded bg-primary text-sm font-bold text-primary-fg">
              {context.organizationName.slice(0, 2)}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-bold">{context.organizationName}</h1>
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
        <div className="space-y-6 px-4 py-4">
          {filtered.map((category) => (
            <section key={category.id} aria-labelledby={`cat-${category.id}`}>
              <h2 id={`cat-${category.id}`} className="mb-2 text-lg font-bold">
                {category.name}
              </h2>
              {category.description && (
                <p className="mb-2 text-sm text-muted">{category.description}</p>
              )}
              <ul className="space-y-2">
                {category.products.map((product) => (
                  <li key={product.id} className="rounded-lg border border-line bg-elevated p-3">
                    <div className="flex gap-3">
                      {product.image_url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={product.image_url}
                          alt=""
                          loading="lazy"
                          className="h-20 w-20 shrink-0 rounded object-cover"
                        />
                      )}
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
                                  'flex min-h-11 items-center gap-2 rounded border px-3 text-sm font-semibold transition-colors',
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
            </section>
          ))}
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
      {cartOpen && (
        <div className="fixed inset-0 z-40 flex flex-col justify-end bg-fg/40">
          <div className="max-h-[85dvh] overflow-y-auto rounded-t-lg bg-elevated p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-bold">طلبك</h2>
              <button type="button" onClick={() => setCartOpen(false)} aria-label="إغلاق">
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
          </div>
        </div>
      )}

      {/* Modifier sheet */}
      {picking && (
        <div className="fixed inset-0 z-40 flex flex-col justify-end bg-fg/40">
          <div className="max-h-[85dvh] overflow-y-auto rounded-t-lg bg-elevated p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-bold">{picking.product.name}</h2>
              <button type="button" onClick={() => setPicking(null)} aria-label="إغلاق">
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
          </div>
        </div>
      )}
    </main>
  );
}
