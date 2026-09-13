'use client';

import { useMemo, useRef, useState, useTransition, useEffect } from 'react';
import { Minus, Plus, Search, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { formatMoney, lineTotalCents } from '@/lib/money';
import { cn } from '@/lib/cn';
import type { PosProduct } from '@/modules/retail/pos/service';
import { createSaleAction } from '../actions';

type CartLine = { product: PosProduct; quantity: number };

/**
 * The till.
 *
 * Built for speed: the catalog is in memory, the barcode field keeps focus, a
 * scan adds a line without a round trip, and the sale is one request. Totals
 * shown here are a preview computed with the same integer maths as the server
 * — the authoritative figures come back from retail_create_sale, which
 * recomputes everything from database prices.
 */
export function PosTerminal({
  catalog,
  currency,
  organizationSlug,
  branchSlug,
  canDiscount,
}: {
  catalog: PosProduct[];
  currency: string;
  organizationSlug: string;
  branchSlug: string;
  canDiscount: boolean;
}) {
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [tendered, setTendered] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{
    number: string;
    totalCents: number;
    paidCents: number;
    changeCents: number;
  } | null>(null);
  const [isPending, startTransition] = useTransition();
  const searchRef = useRef<HTMLInputElement>(null);

  // The scan field is the resting state: after every action focus returns here
  // so the cashier can keep scanning without touching the mouse.
  const refocus = () => searchRef.current?.focus();
  useEffect(refocus, [cart.length, receipt]);

  const results = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return catalog.slice(0, 24);
    return catalog
      .filter(
        (p) =>
          p.barcode?.toLowerCase() === term ||
          p.sku?.toLowerCase() === term ||
          p.productName.toLowerCase().includes(term) ||
          p.variantName.toLowerCase().includes(term),
      )
      .slice(0, 24);
  }, [catalog, search]);

  const totals = useMemo(() => {
    let subtotal = 0;
    let tax = 0;
    for (const line of cart) {
      const { netCents, taxCents } = lineTotalCents({
        unitPriceCents: line.product.priceCents,
        quantity: line.quantity,
        taxRateBp: line.product.taxRateBp,
      });
      subtotal += netCents;
      tax += taxCents;
    }
    return { subtotal, tax, total: subtotal + tax };
  }, [cart]);

  const tenderedCents = useMemo(() => {
    const text = tendered.trim();
    if (!/^\d*(\.\d{0,2})?$/.test(text) || text === '') return 0;
    const [whole = '0', fraction = ''] = text.split('.');
    return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  }, [tendered]);

  function addToCart(product: PosProduct) {
    setError(null);
    setCart((lines) => {
      const existing = lines.find((l) => l.product.variantId === product.variantId);
      if (existing) {
        return lines.map((l) =>
          l.product.variantId === product.variantId ? { ...l, quantity: l.quantity + 1 } : l,
        );
      }
      return [...lines, { product, quantity: 1 }];
    });
    setSearch('');
  }

  function setQuantity(variantId: string, quantity: number) {
    setCart((lines) =>
      quantity <= 0
        ? lines.filter((l) => l.product.variantId !== variantId)
        : lines.map((l) => (l.product.variantId === variantId ? { ...l, quantity } : l)),
    );
  }

  function onScanSubmit(event: React.FormEvent) {
    event.preventDefault();
    const term = search.trim().toLowerCase();
    if (!term) return;
    // An exact barcode or SKU match goes straight into the cart, which is what
    // a scanner produces; otherwise fall back to the first search result.
    const exact = catalog.find(
      (p) => p.barcode?.toLowerCase() === term || p.sku?.toLowerCase() === term,
    );
    const chosen = exact ?? results[0];
    if (chosen) addToCart(chosen);
    else setError('لم يتم العثور على منتج بهذا الباركود.');
  }

  function completeSale() {
    if (cart.length === 0) return;
    setError(null);

    startTransition(async () => {
      const result = await createSaleAction(
        { organizationSlug, branchSlug },
        {
          items: cart.map((l) => ({
            variantId: l.product.variantId,
            quantity: l.quantity,
            discountCents: 0,
          })),
          method: 'cash',
          tenderedCents: tenderedCents || totals.total,
          orderDiscountCents: 0,
        },
      );

      if (!result.ok) {
        setError(result.error);
        return;
      }

      setReceipt({
        number: result.data.invoiceNumber,
        totalCents: result.data.totalCents,
        paidCents: result.data.paidCents,
        changeCents: result.data.changeCents,
      });
      setCart([]);
      setTendered('');
    });
  }

  if (receipt) {
    return (
      <div className="mx-auto max-w-md space-y-4 py-10 text-center">
        <Badge tone="success">تم البيع</Badge>
        <h1 className="text-2xl font-bold">فاتورة {receipt.number}</h1>
        <dl className="space-y-2 rounded-lg border border-line bg-elevated p-5 text-start">
          <div className="flex justify-between">
            <dt className="text-muted">الإجمالي</dt>
            <dd className="lb-numeric font-semibold">{formatMoney(receipt.totalCents, currency)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">المدفوع</dt>
            <dd className="lb-numeric">{formatMoney(receipt.paidCents, currency)}</dd>
          </div>
          <div className="flex justify-between border-t border-line pt-2">
            <dt className="font-semibold">الباقي</dt>
            <dd className="lb-numeric text-lg font-bold text-success">
              {formatMoney(receipt.changeCents, currency)}
            </dd>
          </div>
        </dl>
        <Button size="touch" block onClick={() => setReceipt(null)} autoFocus>
          بيع جديد
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
      {/* Catalog */}
      <section className="space-y-3" aria-label="المنتجات">
        <form onSubmit={onScanSubmit}>
          <div className="relative">
            <Search
              className="pointer-events-none absolute inset-y-0 start-3 my-auto h-5 w-5 text-muted"
              aria-hidden="true"
            />
            <label htmlFor="pos-scan" className="sr-only">
              امسح الباركود أو ابحث عن منتج
            </label>
            <Input
              id="pos-scan"
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="امسح الباركود أو ابحث…"
              className="h-14 ps-10 text-base"
              autoFocus
              autoComplete="off"
            />
          </div>
        </form>

        {error && <Alert tone="danger">{error}</Alert>}

        {results.length === 0 ? (
          <p className="rounded-lg border border-line bg-elevated p-8 text-center text-sm text-muted">
            لا توجد منتجات مطابقة.
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
            {results.map((p) => (
              <li key={p.variantId}>
                <button
                  type="button"
                  onClick={() => addToCart(p)}
                  disabled={p.stock <= 0}
                  className={cn(
                    'flex h-full w-full flex-col items-start gap-1 rounded border p-3 text-start transition-colors',
                    p.stock > 0
                      ? 'border-line bg-elevated hover:border-primary hover:bg-primary-soft'
                      : 'cursor-not-allowed border-line bg-surface opacity-60',
                  )}
                >
                  <span className="line-clamp-2 text-sm font-medium">{p.productName}</span>
                  {p.variantName !== 'default' && (
                    <span className="text-xs text-muted">{p.variantName}</span>
                  )}
                  <span className="lb-numeric mt-auto font-bold text-primary">
                    {formatMoney(p.priceCents, currency)}
                  </span>
                  <span className={cn('text-xs', p.stock <= 0 ? 'text-danger' : 'text-muted')}>
                    {p.stock <= 0 ? 'نفد' : `متاح ${p.stock}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Cart */}
      <aside
        className="flex flex-col gap-3 rounded-lg border border-line bg-elevated p-4 lg:sticky lg:top-20 lg:h-[calc(100dvh-6rem)]"
        aria-label="السلة"
      >
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">السلة</h2>
          {cart.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setCart([])}>
              <X className="h-4 w-4" aria-hidden="true" />
              إفراغ
            </Button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {cart.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted">امسح منتجًا للبدء.</p>
          ) : (
            <ul className="space-y-2">
              {cart.map((line) => (
                <li key={line.product.variantId} className="rounded border border-line p-2">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium">{line.product.productName}</span>
                    <button
                      type="button"
                      onClick={() => setQuantity(line.product.variantId, 0)}
                      aria-label={`حذف ${line.product.productName}`}
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
                        onClick={() => setQuantity(line.product.variantId, line.quantity - 1)}
                      >
                        <Minus className="h-4 w-4" />
                      </Button>
                      <span className="lb-numeric w-10 text-center font-semibold">
                        {line.quantity}
                      </span>
                      <Button
                        size="icon"
                        variant="outline"
                        aria-label="زيادة"
                        disabled={line.quantity >= line.product.stock}
                        onClick={() => setQuantity(line.product.variantId, line.quantity + 1)}
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                    <span className="lb-numeric font-semibold">
                      {formatMoney(line.product.priceCents * line.quantity, currency)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <dl className="space-y-1 border-t border-line pt-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted">المجموع</dt>
            <dd className="lb-numeric">{formatMoney(totals.subtotal, currency)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">الضريبة</dt>
            <dd className="lb-numeric">{formatMoney(totals.tax, currency)}</dd>
          </div>
          <div className="flex justify-between text-base font-bold">
            <dt>الإجمالي</dt>
            <dd className="lb-numeric">{formatMoney(totals.total, currency)}</dd>
          </div>
        </dl>

        <div className="space-y-2">
          <label htmlFor="pos-tendered" className="text-sm font-medium">
            المبلغ المدفوع
          </label>
          <Input
            id="pos-tendered"
            value={tendered}
            onChange={(e) => setTendered(e.target.value)}
            inputMode="decimal"
            dir="ltr"
            placeholder={(totals.total / 100).toFixed(2)}
            className="h-12 text-lg"
          />
          {tenderedCents > totals.total && (
            <p className="text-sm text-success">
              الباقي: <span className="lb-numeric font-semibold">
                {formatMoney(tenderedCents - totals.total, currency)}
              </span>
            </p>
          )}
        </div>

        <Button
          size="touch"
          block
          disabled={cart.length === 0 || isPending}
          onClick={completeSale}
        >
          {isPending ? 'جارٍ الإتمام…' : `إتمام البيع · ${formatMoney(totals.total, currency)}`}
        </Button>
        {!canDiscount && (
          <p className="text-center text-xs text-muted">الخصومات تحتاج صلاحية إضافية.</p>
        )}
      </aside>
    </div>
  );
}
