'use client';

import { useMemo, useState, useTransition } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { checkoutAction, quoteCartAction, type CheckoutState } from '../../actions';
import { FULFILLMENT_LABELS, FULFILLMENT_TYPES, type Fulfillment } from '@/modules/restaurant/online/schemas';
import type { MenuItem, ModifierGroup, Quote } from '@/modules/restaurant/online/service';
import { cn } from '@/lib/cn';

type Line = { variantId: string; quantity: number; modifierIds: string[]; note?: string };

function money(cents: number, currency: string) {
  return `${(cents / 100).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ${currency}`;
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="h-12 w-full rounded bg-primary text-base font-semibold text-primary-fg hover:bg-primary/90 disabled:opacity-50"
    >
      {pending ? 'جارٍ إرسال الطلب…' : 'تأكيد الطلب (الدفع نقدًا)'}
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
}: {
  orgSlug: string;
  branchSlug: string;
  items: MenuItem[];
  modifierGroups: ModifierGroup[];
  currency: string;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [fulfillment, setFulfillment] = useState<Fulfillment>('pickup');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [pricing, startPricing] = useTransition();
  const [state, action] = useFormState<CheckoutState, FormData>(checkoutAction, undefined);

  // One key per checkout attempt, so a double-click or a retry is recognised
  // server-side as the same attempt rather than a second order.
  const [idempotencyKey] = useState(
    () => `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
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

  return (
    <div className="grid gap-8 lg:grid-cols-[1.4fr_1fr]">
      <section>
        <h2 className="mb-4 text-lg font-bold text-fg">المنيو</h2>
        <ul className="space-y-3">
          {items.map((item) => {
            const groups = groupsByProduct.get(item.productId) ?? [];
            return (
              <li key={item.variantId} className="rounded-lg border border-line bg-elevated p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-fg">
                      {item.productName}
                      {item.variantName !== 'default' ? (
                        <span className="text-muted"> — {item.variantName}</span>
                      ) : null}
                    </p>
                    {item.description ? (
                      <p className="mt-0.5 text-sm text-muted">{item.description}</p>
                    ) : null}
                  </div>
                  <span className="shrink-0 font-bold text-fg">
                    {money(item.priceCents, currency)}
                  </span>
                </div>

                <AddControl item={item} groups={groups} currency={currency} onAdd={add} />
              </li>
            );
          })}
        </ul>
      </section>

      <section className="lg:sticky lg:top-4 lg:self-start">
        <h2 className="mb-4 text-lg font-bold text-fg">سلتك</h2>

        <div className="rounded-lg border border-line bg-elevated p-4">
          {lines.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">السلة فارغة.</p>
          ) : (
            <ul className="space-y-2 border-b border-line pb-3">
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
                    <button
                      type="button"
                      aria-label="إنقاص"
                      onClick={() => setQty(i, l.quantity - 1)}
                      className="h-7 w-7 rounded border border-line"
                    >−</button>
                    <span className="w-6 text-center font-semibold">{l.quantity}</span>
                    <button
                      type="button"
                      aria-label="زيادة"
                      onClick={() => setQty(i, l.quantity + 1)}
                      className="h-7 w-7 rounded border border-line"
                    >+</button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mt-3 flex gap-2">
            {FULFILLMENT_TYPES.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => changeFulfillment(f)}
                className={cn(
                  'flex-1 rounded px-3 py-2 text-sm font-semibold',
                  fulfillment === f ? 'bg-primary text-primary-fg' : 'border border-line text-muted',
                )}
              >
                {FULFILLMENT_LABELS[f]}
              </button>
            ))}
          </div>

          {/* Every figure below comes back from the server. */}
          <div className="mt-3 space-y-1 text-sm" aria-live="polite">
            {quoteError ? <p className="text-danger">{quoteError}</p> : null}
            {pricing ? <p className="text-muted">جارٍ الحساب…</p> : null}
            {quote ? (
              <>
                <div className="flex justify-between text-muted">
                  <span>الإجمالي الفرعي</span><span>{money(quote.subtotalCents, quote.currency)}</span>
                </div>
                {quote.taxCents > 0 ? (
                  <div className="flex justify-between text-muted">
                    <span>الضريبة</span><span>{money(quote.taxCents, quote.currency)}</span>
                  </div>
                ) : null}
                {quote.deliveryFeeCents > 0 ? (
                  <div className="flex justify-between text-muted">
                    <span>التوصيل</span><span>{money(quote.deliveryFeeCents, quote.currency)}</span>
                  </div>
                ) : null}
                <div className="flex justify-between border-t border-line pt-1 text-base font-extrabold text-fg">
                  <span>الإجمالي</span>
                  <span data-testid="cart-total">{money(quote.totalCents, quote.currency)}</span>
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

          {state?.error ? (
            <p className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
              {state.error}
            </p>
          ) : null}

          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-fg">الاسم</span>
            <input name="customerName" required maxLength={120}
              className="h-11 w-full rounded border border-line bg-elevated px-3 text-sm text-fg" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-fg">رقم الهاتف</span>
            <input name="customerPhone" required maxLength={32} dir="ltr"
              className="h-11 w-full rounded border border-line bg-elevated px-3 text-sm text-fg" />
          </label>

          {fulfillment === 'delivery' ? (
            <>
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-fg">العنوان</span>
                <input name="address" required maxLength={500}
                  className="h-11 w-full rounded border border-line bg-elevated px-3 text-sm text-fg" />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold text-fg">المدينة</span>
                  <input name="city" maxLength={120}
                    className="h-11 w-full rounded border border-line bg-elevated px-3 text-sm text-fg" />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold text-fg">المنطقة</span>
                  <input name="area" maxLength={120}
                    className="h-11 w-full rounded border border-line bg-elevated px-3 text-sm text-fg" />
                </label>
              </div>
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-fg">علامة مميزة</span>
                <input name="landmark" maxLength={240}
                  className="h-11 w-full rounded border border-line bg-elevated px-3 text-sm text-fg" />
              </label>
            </>
          ) : null}

          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-fg">ملاحظات</span>
            <input name="note" maxLength={500}
              className="h-11 w-full rounded border border-line bg-elevated px-3 text-sm text-fg" />
          </label>

          {lines.length > 0 ? <Submit /> : null}
          <p className="text-center text-xs text-muted">
            الدفع نقدًا عند الاستلام. الأسعار تُحسب على الخادم.
          </p>
        </form>
      </section>
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
    <div className="mt-3">
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
                  'rounded border px-2.5 py-1 text-xs',
                  chosen.includes(m.id)
                    ? 'border-primary bg-primary-soft text-primary'
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
        className="mt-1 rounded bg-primary px-4 py-1.5 text-sm font-semibold text-primary-fg hover:bg-primary/90"
      >
        أضف للسلة
      </button>
    </div>
  );
}
