'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Minus, Plus, ShoppingCart, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { Money } from '@/components/patterns/money';
import { Badge } from '@/components/ui/badge';
import { checkoutAction, quoteCartAction } from './actions';
import type { CatalogItem } from '@/modules/retail/store/service';

type Line = { variantId: string; quantity: number };

/**
 * The shop, the basket and the checkout, on one page.
 *
 * The basket lives in this component and carries nothing but variant ids and
 * quantities. Every number the customer is shown comes back from the server —
 * the local sum below is a hint while typing, and the server's quote replaces
 * it before anyone commits.
 */
export function Storefront({
  orgSlug, branchSlug, name, currency, pickup, delivery,
  deliveryFeeCents, minOrderCents, catalog, search,
}: {
  orgSlug: string;
  branchSlug: string;
  name: string;
  currency: string;
  pickup: boolean;
  delivery: boolean;
  deliveryFeeCents: number;
  minOrderCents: number;
  catalog: CatalogItem[];
  search: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<{
    subtotalCents: number; taxCents: number; feeCents: number; totalCents: number;
  } | null>(null);
  const [fulfillment, setFulfillment] = useState<'pickup' | 'delivery'>(
    pickup ? 'pickup' : 'delivery',
  );

  /**
   * One key per checkout attempt. Regenerated after a successful order so the
   * next basket is a new order, not a replay of the last one.
   */
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const byId = useMemo(() => new Map(catalog.map((c) => [c.variantId, c])), [catalog]);

  function setQuantity(variantId: string, quantity: number) {
    setLines((rows) => {
      if (quantity <= 0) return rows.filter((r) => r.variantId !== variantId);
      const existing = rows.find((r) => r.variantId === variantId);
      if (existing) {
        return rows.map((r) => (r.variantId === variantId ? { ...r, quantity } : r));
      }
      return [...rows, { variantId, quantity }];
    });
  }

  /** A hint while the basket changes. The server's quote is what counts. */
  const localSubtotal = lines.reduce(
    (sum, l) => sum + (byId.get(l.variantId)?.priceCents ?? 0) * l.quantity,
    0,
  );

  // Re-quote whenever the basket or the fulfilment type changes, so the total
  // on screen is always one the server computed.
  useEffect(() => {
    if (lines.length === 0) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    quoteCartAction({ orgSlug, branchSlug, items: lines, fulfillment }).then((result) => {
      if (cancelled) return;
      setQuote(result.ok ? result : null);
    });
    return () => {
      cancelled = true;
    };
  }, [orgSlug, branchSlug, lines, fulfillment]);

  function onCheckout(formData: FormData) {
    setError(null);
    if (lines.length === 0) {
      setError('السلة فارغة.');
      return;
    }

    startTransition(async () => {
      const result = await checkoutAction({
        orgSlug,
        branchSlug,
        items: lines,
        fulfillment,
        paymentMethod: fulfillment === 'delivery' ? 'cash_on_delivery' : 'pay_on_collection',
        contactName: String(formData.get('contactName') ?? ''),
        contactPhone: String(formData.get('contactPhone') ?? ''),
        note: String(formData.get('note') ?? ''),
        idempotencyKey,
        recipientName: String(formData.get('recipientName') ?? ''),
        addressPhone: String(formData.get('contactPhone') ?? ''),
        city: String(formData.get('city') ?? ''),
        area: String(formData.get('area') ?? ''),
        addressLine: String(formData.get('addressLine') ?? ''),
        landmark: String(formData.get('landmark') ?? ''),
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }
      setIdempotencyKey(crypto.randomUUID());
      router.push(`/shop/track/${result.token}`);
    });
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-6" dir="rtl">
      <header className="mb-5">
        <h1 className="text-xl font-bold text-fg">{name}</h1>
        <p className="text-sm text-muted">اطلب أونلاين واستلم من الفرع أو اطلب التوصيل.</p>
      </header>

      {error ? <Alert tone="danger" className="mb-4">{error}</Alert> : null}

      <form method="get" className="mb-4 flex gap-2">
        <Input name="q" defaultValue={search} placeholder="ابحث عن منتج" aria-label="ابحث" />
        <Button type="submit" variant="outline" size="sm">بحث</Button>
      </form>

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <section aria-label="المنتجات" className="space-y-2">
          {catalog.length === 0 ? (
            <p className="rounded border border-line bg-elevated p-6 text-center text-sm text-muted">
              لا توجد منتجات معروضة حاليًا.
            </p>
          ) : (
            catalog.map((item) => {
              const line = lines.find((l) => l.variantId === item.variantId);
              const label =
                item.variantName && item.variantName !== 'default'
                  ? `${item.productName} — ${item.variantName}`
                  : item.productName;
              return (
                <article
                  key={item.variantId}
                  data-testid={`product-${item.variantId}`}
                  className="flex flex-wrap items-center gap-3 rounded border border-line bg-elevated p-3"
                >
                  <div className="min-w-0 flex-1">
                    <h2 className="text-sm font-semibold text-fg">{label}</h2>
                    {item.category ? (
                      <p className="text-xs text-muted">{item.category}</p>
                    ) : null}
                    {!item.inStock ? (
                      <Badge tone="danger" className="mt-1">غير متوفر</Badge>
                    ) : null}
                  </div>

                  <Money cents={item.priceCents} currency={currency} className="font-semibold" />

                  {item.inStock ? (
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`إنقاص ${label}`}
                        onClick={() => setQuantity(item.variantId, (line?.quantity ?? 0) - 1)}
                      >
                        <Minus className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <span className="lb-numeric w-8 text-center text-sm">
                        {line?.quantity ?? 0}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        data-testid={`add-${item.variantId}`}
                        aria-label={`إضافة ${label}`}
                        onClick={() => setQuantity(item.variantId, (line?.quantity ?? 0) + 1)}
                      >
                        <Plus className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  ) : null}
                </article>
              );
            })
          )}
        </section>

        <aside aria-label="السلة" className="space-y-3">
          <div className="rounded border border-line bg-elevated p-4">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-fg">
              <ShoppingCart className="h-4 w-4" aria-hidden="true" />
              السلة
            </h2>

            {lines.length === 0 ? (
              <p className="text-sm text-muted">لم تُضِف شيئًا بعد.</p>
            ) : (
              <ul className="mb-3 space-y-2 text-sm">
                {lines.map((l) => {
                  const item = byId.get(l.variantId);
                  if (!item) return null;
                  return (
                    <li key={l.variantId} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">{item.productName}</span>
                      <span className="lb-numeric text-muted">×{l.quantity}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`حذف ${item.productName}`}
                        onClick={() => setQuantity(l.variantId, 0)}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* Every figure below is the server's. The local sum is only shown
                while a quote is in flight, and is replaced the moment one
                arrives. */}
            <dl className="space-y-1 border-t border-line pt-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted">المجموع</dt>
                <dd>
                  <Money
                    cents={quote?.subtotalCents ?? localSubtotal}
                    currency={currency}
                  />
                </dd>
              </div>
              {quote && quote.taxCents > 0 ? (
                <div className="flex justify-between">
                  <dt className="text-muted">الضريبة</dt>
                  <dd><Money cents={quote.taxCents} currency={currency} /></dd>
                </div>
              ) : null}
              {quote && quote.feeCents > 0 ? (
                <div className="flex justify-between">
                  <dt className="text-muted">رسوم التوصيل</dt>
                  <dd><Money cents={quote.feeCents} currency={currency} /></dd>
                </div>
              ) : null}
              <div className="flex justify-between border-t border-line pt-1 font-bold">
                <dt>الإجمالي</dt>
                <dd data-testid="cart-total">
                  <Money cents={quote?.totalCents ?? localSubtotal} currency={currency} />
                </dd>
              </div>
            </dl>

            {minOrderCents > 0 ? (
              <p className="mt-2 text-xs text-muted">
                الحد الأدنى للطلب <Money cents={minOrderCents} currency={currency} />
              </p>
            ) : null}
          </div>

          <form action={onCheckout} className="space-y-3 rounded border border-line bg-elevated p-4">
            <h2 className="text-sm font-bold text-fg">بياناتك</h2>

            <Field label="طريقة الاستلام" required>
              {(p) => (
                <Select
                  {...p}
                  value={fulfillment}
                  onChange={(e) => setFulfillment(e.target.value as 'pickup' | 'delivery')}
                >
                  {pickup ? <option value="pickup">استلام من الفرع</option> : null}
                  {delivery ? <option value="delivery">توصيل</option> : null}
                </Select>
              )}
            </Field>

            <Field label="الاسم" required>
              {(p) => <Input {...p} name="contactName" required maxLength={120} />}
            </Field>

            <Field label="رقم الهاتف" required>
              {(p) => <Input {...p} name="contactPhone" dir="ltr" required maxLength={30} />}
            </Field>

            {fulfillment === 'delivery' ? (
              <>
                <Field label="اسم المستلم">
                  {(p) => <Input {...p} name="recipientName" maxLength={120} />}
                </Field>
                <Field label="المدينة" required>
                  {(p) => <Input {...p} name="city" required maxLength={80} />}
                </Field>
                <Field label="المنطقة">
                  {(p) => <Input {...p} name="area" maxLength={120} />}
                </Field>
                <Field label="العنوان" required>
                  {(p) => <Textarea {...p} name="addressLine" required rows={2} maxLength={400} />}
                </Field>
                <Field label="علامة مميزة">
                  {(p) => <Input {...p} name="landmark" maxLength={200} />}
                </Field>
                <p className="text-xs text-muted">
                  الدفع عند الاستلام. رسوم التوصيل{' '}
                  <Money cents={deliveryFeeCents} currency={currency} />
                </p>
              </>
            ) : (
              <p className="text-xs text-muted">الدفع عند الاستلام من الفرع.</p>
            )}

            <Field label="ملاحظات">
              {(p) => <Textarea {...p} name="note" rows={2} maxLength={500} />}
            </Field>

            <Button
              type="submit"
              className="w-full"
              disabled={isPending || lines.length === 0}
              data-testid="place-order"
            >
              {isPending ? '…' : 'تأكيد الطلب'}
            </Button>
          </form>
        </aside>
      </div>
    </main>
  );
}
