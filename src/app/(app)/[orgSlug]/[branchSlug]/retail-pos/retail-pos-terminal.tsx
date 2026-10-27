'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import {
  Banknote, BadgePercent, CheckCircle2, CreditCard, Loader2, Minus, Plus, ReceiptText, ScanBarcode,
  Search, Sparkles, Tag, Trash2, Undo2, UserRound, Wallet, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { formatMoney, lineTotalCents } from '@/lib/money';
import { toCents, fromCents } from '@/lib/amount-input';
import { cn } from '@/lib/cn';
import type {
  CheckoutResult, PosCustomer, PromotionLine, RetailPosCatalog, RetailPosItem,
} from '@/modules/retail/operations/service';
import { checkoutAction, lookupBarcodeAction, lookupCustomerAction, previewPromotionsAction } from './actions';
import { ReturnsDialog, type ReturnOutcome } from './returns-dialog';

type Scope = { organizationSlug: string; branchSlug: string };
export type CartLine = { item: RetailPosItem; quantity: number };
type Method = 'cash' | 'card';

/** Units sold by measure: quantities are decimals and edited by typing. */
const MEASURED = new Set(['kg', 'gram', 'litre', 'metre']);
const UNIT_LABELS: Record<string, string> = {
  piece: 'قطعة', kg: 'كجم', gram: 'جم', litre: 'لتر', metre: 'متر', box: 'علبة', pack: 'عبوة',
};

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The retail till.
 *
 * The scan field is the resting state: after every action focus returns to it
 * so a hardware scanner (which types the code and presses Enter) can keep
 * firing. A code found in the in-memory catalog is added instantly; anything
 * else (a carton barcode, a scale label carrying the weight) asks the
 * database through retail_barcode_lookup.
 *
 * Promotions are re-priced by the database a moment after the cart, the code
 * or the customer changes, so what the cashier sees is what checkout applies.
 */
export function RetailPosTerminal({
  catalog, currency, scope, permissions,
}: {
  catalog: RetailPosCatalog;
  currency: string;
  scope: Scope;
  permissions: { sell: boolean; pay: boolean; discount: boolean; returns: boolean };
}) {
  const money = useCallback((cents: number) => formatMoney(cents, currency), [currency]);
  const byId = useMemo(() => new Map(catalog.items.map((i) => [i.variantId, i])), [catalog.items]);

  // ---- catalog and scanning ---------------------------------------------------
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'danger' | 'warn' | 'success'; text: string } | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);

  // ---- cart, customer, promotions ----------------------------------------------
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customer, setCustomer] = useState<PosCustomer | null>(null);
  const [codeInput, setCodeInput] = useState('');
  const [appliedCode, setAppliedCode] = useState('');
  const [promos, setPromos] = useState<PromotionLine[]>([]);
  const [promoState, setPromoState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [promoError, setPromoError] = useState<string | null>(null);
  const previewSeq = useRef(0);

  // ---- payment ---------------------------------------------------------------
  const [method, setMethod] = useState<Method>('cash');
  const [tendered, setTendered] = useState('');
  const [useCredit, setUseCredit] = useState(false);
  const [creditInput, setCreditInput] = useState('');
  const [orderDiscount, setOrderDiscount] = useState('');
  const [receipt, setReceipt] = useState<(CheckoutResult & { customerName: string | null; method: Method }) | null>(null);
  const [isPaying, startPaying] = useTransition();
  const [returnsOpen, setReturnsOpen] = useState(false);

  const refocus = useCallback(() => { requestAnimationFrame(() => scanRef.current?.focus()); }, []);
  useEffect(() => { if (!returnsOpen) refocus(); }, [cart.length, receipt, returnsOpen, refocus]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return catalog.items
      .filter((i) => !category || i.categoryId === category)
      .filter((i) => !term
        || i.productName.toLowerCase().includes(term)
        || i.variantName.toLowerCase().includes(term)
        || i.sku?.toLowerCase() === term
        || i.barcode?.toLowerCase() === term)
      .slice(0, 60);
  }, [catalog.items, category, search]);

  // ---- cart operations ---------------------------------------------------------------
  const addItem = useCallback((item: RetailPosItem, quantity = 1) => {
    setNotice(null);
    setCart((lines) => {
      const current = lines.find((l) => l.item.variantId === item.variantId);
      const next = round3((current?.quantity ?? 0) + quantity);
      if (next > item.stock) {
        setNotice({ tone: 'warn', text: `المتاح من «${item.productName}» ${item.stock} فقط في هذا الفرع.` });
        return lines;
      }
      if (current) return lines.map((l) => (l.item.variantId === item.variantId ? { ...l, quantity: next } : l));
      return [{ item, quantity: next }, ...lines];
    });
  }, []);

  function setQuantity(variantId: string, quantity: number) {
    setCart((lines) => lines.flatMap((l) => {
      if (l.item.variantId !== variantId) return [l];
      const q = round3(quantity);
      if (!Number.isFinite(q) || q <= 0) return [];
      if (q > l.item.stock) {
        setNotice({ tone: 'warn', text: `المتاح من «${l.item.productName}» ${l.item.stock} فقط.` });
        return [{ ...l, quantity: l.item.stock }];
      }
      return [{ ...l, quantity: q }];
    }));
  }

  async function scan(raw: string) {
    const code = raw.trim();
    if (!code) return;
    const lower = code.toLowerCase();
    const local = catalog.items.find((i) => i.barcode?.toLowerCase() === lower || i.sku?.toLowerCase() === lower);
    if (local) { addItem(local, 1); setSearch(''); return; }

    // A name typed by hand: Enter takes the first match.
    if (/\s/.test(code) || !/^[0-9A-Za-z._-]{3,64}$/.test(code)) {
      if (visible[0]) { addItem(visible[0], 1); setSearch(''); }
      else setNotice({ tone: 'danger', text: 'لا يوجد صنف مطابق.' });
      return;
    }

    // Carton barcodes and scale labels are resolved by the database.
    setScanning(true);
    const r = await lookupBarcodeAction(scope, { code });
    setScanning(false);
    setSearch('');
    if (!r.ok) { setNotice({ tone: 'danger', text: r.error }); return; }
    if (!r.data) { setNotice({ tone: 'danger', text: `لا يوجد صنف بالكود ${code}.` }); return; }
    const item = byId.get(r.data.variantId);
    if (!item) { setNotice({ tone: 'danger', text: 'الصنف غير متاح للبيع في هذا الفرع.' }); return; }
    addItem(item, r.data.quantity);
    if (r.data.matchedBy === 'scale') {
      setNotice({ tone: 'success', text: `ميزان: ${r.data.quantity} ${UNIT_LABELS[item.unit] ?? ''} من «${item.productName}».` });
    } else if (r.data.matchedBy === 'alternate' && r.data.quantity !== 1) {
      setNotice({ tone: 'success', text: `كرتونة: ${r.data.quantity} × «${item.productName}».` });
    }
  }

  function simulateScan() {
    const codes = catalog.items.filter((i) => i.stock > 0).map((i) => i.barcode ?? i.sku).filter((c): c is string => !!c);
    if (codes.length === 0) { setNotice({ tone: 'warn', text: 'لا توجد أصناف لها باركود أو SKU للمحاكاة.' }); return; }
    void scan(codes[Math.floor(Math.random() * codes.length)]!);
  }

  // ---- promotions preview (debounced, last request wins) --------------------------------
  const previewKey = useMemo(
    () => JSON.stringify([cart.map((l) => [l.item.variantId, l.quantity]), appliedCode, customer?.customerId ?? null]),
    [cart, appliedCode, customer],
  );
  useEffect(() => {
    if (cart.length === 0) { setPromos([]); setPromoState('idle'); setPromoError(null); return; }
    const seq = ++previewSeq.current;
    setPromoState('loading');
    const timer = setTimeout(async () => {
      const r = await previewPromotionsAction(scope, {
        items: cart.map((l) => ({ variantId: l.item.variantId, quantity: l.quantity })),
        customerId: customer?.customerId ?? null,
        code: appliedCode || undefined,
      });
      if (seq !== previewSeq.current) return;
      if (r.ok) { setPromos(r.data); setPromoState('idle'); setPromoError(null); }
      else { setPromos([]); setPromoState('error'); setPromoError(r.error); }
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);

  const applied = promos.filter((p) => p.applied && p.discountCents > 0);
  const codeRejected = !!appliedCode && promoState === 'idle' && cart.length > 0
    && !applied.some((p) => p.code?.toLowerCase() === appliedCode.toLowerCase());

  // ---- totals (preview; the database recomputes) ----------------------------------------
  const totals = useMemo(() => {
    let gross = 0;
    let tax = 0;
    for (const l of cart) {
      const t = lineTotalCents({ unitPriceCents: l.item.priceCents, quantity: l.quantity, taxRateBp: l.item.taxRateBp });
      gross += t.netCents;
      tax += t.taxCents;
    }
    const promo = Math.min(applied.reduce((s, p) => s + p.discountCents, 0), gross);
    const manual = permissions.discount ? Math.min(toCents(orderDiscount) ?? 0, gross - promo + tax) : 0;
    const total = Math.max(gross - promo - manual + tax, 0);
    const multiplier = applied.reduce((m, p) => Math.max(m, p.pointsMultiplier), 1);
    return { gross, tax, promo, manual, total, multiplier };
  }, [cart, applied, orderDiscount, permissions.discount]);

  const creditAvailable = customer && permissions.pay ? customer.storeCreditCents : 0;
  const creditCents = useCredit && creditAvailable > 0
    ? Math.min(toCents(creditInput) ?? creditAvailable, creditAvailable, totals.total)
    : 0;
  const remaining = totals.total - creditCents;
  const tenderedCents = method === 'card' ? remaining : (tendered.trim() === '' ? remaining : (toCents(tendered) ?? -1));
  const change = method === 'cash' && tenderedCents > remaining ? tenderedCents - remaining : 0;

  const blocker =
    !permissions.sell ? 'لا تملك صلاحية إصدار الفواتير.'
    : cart.length === 0 ? null
    : !permissions.pay && remaining > 0 ? 'لا تملك صلاحية تسجيل المدفوعات.'
    : codeRejected ? 'كود الخصم لا ينطبق على هذه السلة؛ عدّل السلة أو أزل الكود.'
    : promoState === 'loading' ? 'جارٍ تحديث العروض…'
    : method === 'cash' && tenderedCents < 0 ? 'المبلغ المدفوع غير صالح.'
    : method === 'cash' && tenderedCents < remaining ? 'المبلغ المدفوع أقل من المطلوب.'
    : null;

  function reset() {
    setCart([]); setCustomer(null); setCodeInput(''); setAppliedCode(''); setPromos([]);
    setTendered(''); setUseCredit(false); setCreditInput(''); setOrderDiscount(''); setMethod('cash'); setNotice(null);
  }

  function pay() {
    if (blocker || cart.length === 0) return;
    setNotice(null);
    startPaying(async () => {
      const r = await checkoutAction(scope, {
        items: cart.map((l) => ({ variantId: l.item.variantId, quantity: l.quantity, discountCents: 0 })),
        method: remaining === 0 ? 'cash' : method,
        tenderedCents: Math.max(tenderedCents, 0),
        customerId: customer?.customerId ?? null,
        promoCode: appliedCode || undefined,
        storeCreditCents: creditCents,
        orderDiscountCents: totals.manual,
      });
      if (!r.ok) {
        setNotice({
          tone: 'danger',
          text: r.code === 'forbidden' || r.code === 'not_found' ? 'لا تملك صلاحية إتمام هذا البيع.' : r.error,
        });
        return;
      }
      setReceipt({ ...r.data, customerName: customer?.name ?? null, method });
      reset();
    });
  }

  function onReturnDone(outcome: ReturnOutcome) {
    setReturnsOpen(false);
    if (outcome.exchanged) setCart([]);
    setNotice({ tone: 'success', text: outcome.message });
  }

  // ---- receipt ---------------------------------------------------------------------------
  if (receipt) {
    return (
      <div className="mx-auto max-w-md space-y-5 py-8">
        <div className="space-y-2 text-center">
          <CheckCircle2 className="mx-auto h-12 w-12 text-success" aria-hidden="true" />
          <h1 className="text-2xl font-bold">تم البيع</h1>
          <p className="text-sm text-muted">فاتورة <span className="lb-numeric font-semibold text-fg">{receipt.invoiceNumber}</span>
            {receipt.customerName ? <> · {receipt.customerName}</> : null}</p>
        </div>
        <dl className="space-y-2 rounded-lg border border-line bg-elevated p-5 text-sm">
          {receipt.promoCents > 0 && <Row label="خصم العروض" value={`− ${money(receipt.promoCents)}`} tone="success" />}
          <Row label="الإجمالي" value={money(receipt.totalCents)} strong />
          {receipt.storeCreditCents > 0 && <Row label="من رصيد المتجر" value={money(receipt.storeCreditCents)} />}
          <Row label={receipt.method === 'card' ? 'بطاقة' : 'نقدي'} value={money(receipt.paidCents)} />
          {receipt.changeCents > 0 && (
            <div className="flex items-center justify-between border-t border-line pt-3">
              <dt className="font-semibold">الباقي للعميل</dt>
              <dd className="lb-numeric text-2xl font-bold text-success">{money(receipt.changeCents)}</dd>
            </div>
          )}
          {receipt.pointsEarned > 0 && (
            <p className="flex items-center gap-2 rounded bg-primary-soft px-3 py-2 text-primary">
              <Sparkles className="h-4 w-4" aria-hidden="true" /> أضيفت {receipt.pointsEarned} نقطة ولاء
            </p>
          )}
        </dl>
        <Button size="touch" block onClick={() => setReceipt(null)} autoFocus>بيع جديد</Button>
      </div>
    );
  }

  // ---- till ------------------------------------------------------------------------------
  return (
    <div className="grid gap-4 lg:grid-cols-[400px_minmax(0,1fr)]">
      {/* Catalog: start of the reading order on small screens, the far side on large. */}
      <section className="min-w-0 space-y-3 lg:order-2" aria-label="الأصناف">
        <form onSubmit={(e) => { e.preventDefault(); void scan(search); }} className="flex gap-2">
          <div className="relative flex-1">
            {scanning
              ? <Loader2 className="pointer-events-none absolute inset-y-0 start-3 my-auto h-5 w-5 animate-spin text-primary" aria-hidden="true" />
              : <ScanBarcode className="pointer-events-none absolute inset-y-0 start-3 my-auto h-5 w-5 text-muted" aria-hidden="true" />}
            <label htmlFor="rpos-scan" className="sr-only">امسح الباركود أو ابحث باسم الصنف</label>
            <Input
              id="rpos-scan"
              ref={scanRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="امسح الباركود أو اكتب اسم الصنف ثم Enter"
              className="h-14 ps-11 text-base"
              autoComplete="off"
              autoFocus
              data-testid="rpos-scan"
            />
          </div>
          <Button type="button" variant="outline" size="lg" className="h-14" onClick={simulateScan} title="محاكاة ماسح الباركود">
            <ScanBarcode className="h-5 w-5" aria-hidden="true" />
            <span className="hidden sm:inline">محاكاة مسح</span>
          </Button>
          {permissions.returns && (
            <Button type="button" variant="secondary" size="lg" className="h-14" onClick={() => setReturnsOpen(true)} data-testid="rpos-returns">
              <Undo2 className="h-5 w-5" aria-hidden="true" />
              <span className="hidden sm:inline">مرتجع</span>
            </Button>
          )}
        </form>

        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

        <nav aria-label="الأقسام" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          <CategoryChip active={category === null} onClick={() => setCategory(null)}>الكل</CategoryChip>
          {catalog.categories.map((c) => (
            <CategoryChip key={c.id} active={category === c.id} onClick={() => setCategory(c.id)}>{c.name}</CategoryChip>
          ))}
        </nav>

        {visible.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line bg-elevated p-10 text-center text-sm text-muted">
            <Search className="h-6 w-6" aria-hidden="true" />
            لا توجد أصناف مطابقة.
          </div>
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {visible.map((item) => {
              const out = item.stock <= 0;
              return (
                <li key={item.variantId}>
                  <button
                    type="button"
                    onClick={() => { addItem(item, 1); refocus(); }}
                    disabled={out}
                    className={cn(
                      'flex h-full w-full flex-col items-start gap-1 rounded-lg border p-3 text-start transition-colors',
                      out ? 'cursor-not-allowed border-line bg-surface opacity-60'
                          : 'border-line bg-elevated hover:border-primary hover:bg-primary-soft',
                    )}
                  >
                    <span className="line-clamp-2 text-sm font-medium">{item.productName}</span>
                    {item.variantName !== 'default' && <span className="text-xs text-muted">{item.variantName}</span>}
                    <span className="lb-numeric mt-auto pt-1 font-bold text-primary">
                      {money(item.priceCents)}
                      {MEASURED.has(item.unit) && <span className="text-xs font-normal text-muted"> / {UNIT_LABELS[item.unit]}</span>}
                    </span>
                    <span className={cn('text-xs', out ? 'text-danger' : item.stock < 5 ? 'text-warn' : 'text-muted')}>
                      {out ? 'نفد' : `متاح ${item.stock} ${UNIT_LABELS[item.unit] ?? ''}`}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Cart */}
      <aside
        className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-elevated p-4 lg:order-1 lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)]"
        aria-label="السلة"
      >
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-semibold">
            <ReceiptText className="h-5 w-5 text-primary" aria-hidden="true" /> السلة
            {cart.length > 0 && <Badge tone="info">{cart.length}</Badge>}
          </h2>
          {cart.length > 0 && (
            <Button size="sm" variant="ghost" onClick={reset}>
              <X className="h-4 w-4" aria-hidden="true" /> إفراغ
            </Button>
          )}
        </div>

        <CustomerPanel scope={scope} customer={customer} onChange={(c) => { setCustomer(c); setUseCredit(false); setCreditInput(''); }} money={money} />

        <div className="min-h-[8rem] flex-1 overflow-y-auto">
          {cart.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted">امسح صنفًا للبدء.</p>
          ) : (
            <ul className="space-y-2">
              {cart.map((line) => (
                <CartRow key={line.item.variantId} line={line} money={money} onQuantity={(q) => setQuantity(line.item.variantId, q)} />
              ))}
            </ul>
          )}
        </div>

        {/* Promo code */}
        <form
          className="flex gap-2"
          onSubmit={(e) => { e.preventDefault(); setAppliedCode(codeInput.trim()); refocus(); }}
          aria-label="كود الخصم"
        >
          <div className="relative flex-1">
            <Tag className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-muted" aria-hidden="true" />
            <Input
              aria-label="كود الخصم"
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
              placeholder="كود خصم (مثل EID)"
              dir="ltr"
              maxLength={32}
              className="ps-9"
              data-testid="rpos-code"
            />
          </div>
          {appliedCode ? (
            <Button variant="outline" onClick={() => { setAppliedCode(''); setCodeInput(''); }}>إزالة</Button>
          ) : (
            <Button type="submit" variant="secondary" disabled={!codeInput.trim()}>تطبيق</Button>
          )}
        </form>
        {codeRejected && <p className="text-xs text-danger" role="alert">الكود «{appliedCode}» غير صالح أو لا ينطبق على هذه السلة.</p>}
        {promoState === 'error' && promoError && <p className="text-xs text-danger" role="alert">{promoError}</p>}

        {applied.length > 0 && (
          <ul className="space-y-1 rounded border border-success/30 bg-success/5 p-2 text-sm" aria-label="العروض المطبقة">
            {applied.map((p) => (
              <li key={p.promotionId} className="flex items-center justify-between gap-2 text-success">
                <span className="flex items-center gap-1.5"><BadgePercent className="h-4 w-4" aria-hidden="true" />{p.name}
                  {p.code && <Badge tone="success">{p.code}</Badge>}
                  {p.pointsMultiplier > 1 && <Badge tone="info">نقاط ×{p.pointsMultiplier}</Badge>}</span>
                <span className="lb-numeric font-semibold">− {money(p.discountCents)}</span>
              </li>
            ))}
          </ul>
        )}

        {/* Totals */}
        <dl className="space-y-1 border-t border-line pt-3 text-sm">
          <Row label="المجموع" value={money(totals.gross)} />
          {totals.promo > 0 && <Row label="خصم العروض" value={`− ${money(totals.promo)}`} tone="success" />}
          {totals.tax > 0 && <Row label="الضريبة" value={money(totals.tax)} />}
          {permissions.discount && cart.length > 0 && (
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted">خصم يدوي</dt>
              <dd><Input aria-label="خصم يدوي" value={orderDiscount} onChange={(e) => setOrderDiscount(e.target.value)} inputMode="decimal" dir="ltr" placeholder="0.00" className="h-8 w-28 text-end" /></dd>
            </div>
          )}
          <div className="flex items-center justify-between pt-1 text-lg font-bold">
            <dt>الإجمالي</dt>
            <dd className="lb-numeric" data-testid="rpos-total">
              {promoState === 'loading' ? <Loader2 className="inline h-4 w-4 animate-spin text-muted" aria-label="جارٍ التحديث" /> : null} {money(totals.total)}
            </dd>
          </div>
          {customer?.loyaltyEnabled && totals.total > 0 && totals.multiplier > 1 && (
            <p className="text-xs text-primary">عرض نقاط مضاعفة ×{totals.multiplier} على هذه الفاتورة.</p>
          )}
        </dl>

        {/* Store credit */}
        {creditAvailable > 0 && cart.length > 0 && (
          <div className="space-y-2 rounded border border-line p-2">
            <label className="flex items-center justify-between gap-2 text-sm">
              <span className="flex items-center gap-2"><Wallet className="h-4 w-4 text-primary" aria-hidden="true" />
                استخدام رصيد المتجر <span className="lb-numeric text-muted">({money(creditAvailable)})</span></span>
              <input type="checkbox" className="h-5 w-5 accent-[var(--color-primary)]" checked={useCredit}
                onChange={(e) => { setUseCredit(e.target.checked); setCreditInput(e.target.checked ? fromCents(Math.min(creditAvailable, totals.total)) : ''); }} />
            </label>
            {useCredit && (
              <Input aria-label="المبلغ من الرصيد" value={creditInput} onChange={(e) => setCreditInput(e.target.value)} inputMode="decimal" dir="ltr" className="h-9" />
            )}
          </div>
        )}

        {/* Tender */}
        {cart.length > 0 && remaining > 0 && (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="طريقة الدفع">
              <MethodButton active={method === 'cash'} onClick={() => setMethod('cash')} icon={Banknote}>نقدي</MethodButton>
              <MethodButton active={method === 'card'} onClick={() => { setMethod('card'); setTendered(''); }} icon={CreditCard}>بطاقة</MethodButton>
            </div>
            {method === 'cash' && (
              <div className="space-y-1">
                <label htmlFor="rpos-tendered" className="text-sm font-medium">المبلغ المستلم</label>
                <Input id="rpos-tendered" value={tendered} onChange={(e) => setTendered(e.target.value)} inputMode="decimal" dir="ltr"
                  placeholder={fromCents(remaining)} className="h-12 text-lg" data-testid="rpos-tendered" />
                {change > 0 && <p className="text-sm text-success">الباقي: <span className="lb-numeric font-bold">{money(change)}</span></p>}
              </div>
            )}
          </div>
        )}

        {blocker && cart.length > 0 && <p className="text-xs text-warn">{blocker}</p>}
        <Button size="touch" block disabled={cart.length === 0 || !!blocker || isPaying} onClick={pay} data-testid="rpos-pay">
          {isPaying ? <><Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> جارٍ الإتمام…</>
            : `دفع · ${money(remaining > 0 ? remaining : totals.total)}`}
        </Button>
      </aside>

      {permissions.returns && (
        <ReturnsDialog
          open={returnsOpen}
          scope={scope}
          currency={currency}
          cart={cart}
          cartTotalCents={totals.total}
          attachedCustomer={customer}
          onClose={() => setReturnsOpen(false)}
          onDone={onReturnDone}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------
function Row({ label, value, tone, strong }: { label: string; value: string; tone?: 'success'; strong?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between', strong && 'text-base font-bold')}>
      <dt className={strong ? undefined : 'text-muted'}>{label}</dt>
      <dd className={cn('lb-numeric', tone === 'success' && 'text-success')}>{value}</dd>
    </div>
  );
}

function CategoryChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'shrink-0 rounded-full border px-4 py-1.5 text-sm transition-colors',
        active ? 'border-primary bg-primary text-primary-fg' : 'border-line bg-elevated text-fg hover:border-primary',
      )}
    >
      {children}
    </button>
  );
}

function MethodButton({ active, onClick, icon: Icon, children }: {
  active: boolean; onClick: () => void; icon: typeof Banknote; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        'flex h-11 items-center justify-center gap-2 rounded border text-sm font-medium transition-colors',
        active ? 'border-primary bg-primary-soft text-primary' : 'border-line bg-elevated hover:bg-surface',
      )}
    >
      <Icon className="h-4 w-4" aria-hidden="true" /> {children}
    </button>
  );
}

function CartRow({ line, money, onQuantity }: { line: CartLine; money: (c: number) => string; onQuantity: (q: number) => void }) {
  const measured = MEASURED.has(line.item.unit);
  const [draft, setDraft] = useState(String(line.quantity));
  useEffect(() => { setDraft(String(line.quantity)); }, [line.quantity]);
  const total = lineTotalCents({ unitPriceCents: line.item.priceCents, quantity: line.quantity }).netCents;

  return (
    <li className="rounded border border-line p-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{line.item.productName}</p>
          <p className="text-xs text-muted">
            {line.item.variantName !== 'default' ? `${line.item.variantName} · ` : ''}
            <span className="lb-numeric">{money(line.item.priceCents)}</span>{measured ? ` / ${UNIT_LABELS[line.item.unit]}` : ''}
          </p>
        </div>
        <button type="button" onClick={() => onQuantity(0)} aria-label={`حذف ${line.item.productName}`} className="text-muted hover:text-danger">
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        {measured ? (
          <div className="flex items-center gap-1">
            <Input
              aria-label={`الكمية بال${UNIT_LABELS[line.item.unit]}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => { const q = Number(draft); if (Number.isFinite(q)) onQuantity(q); else setDraft(String(line.quantity)); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              inputMode="decimal"
              dir="ltr"
              className="h-9 w-24 text-center"
            />
            <span className="text-xs text-muted">{UNIT_LABELS[line.item.unit]}</span>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <Button size="icon" variant="outline" aria-label="إنقاص" onClick={() => onQuantity(line.quantity - 1)}><Minus className="h-4 w-4" /></Button>
            <span className="lb-numeric w-10 text-center font-semibold">{line.quantity}</span>
            <Button size="icon" variant="outline" aria-label="زيادة" disabled={line.quantity >= line.item.stock} onClick={() => onQuantity(line.quantity + 1)}><Plus className="h-4 w-4" /></Button>
          </div>
        )}
        <span className="lb-numeric font-semibold">{money(total)}</span>
      </div>
    </li>
  );
}

function CustomerPanel({ scope, customer, onChange, money }: {
  scope: Scope; customer: PosCustomer | null; onChange: (c: PosCustomer | null) => void; money: (c: number) => string;
}) {
  const [phone, setPhone] = useState('');
  const [results, setResults] = useState<PosCustomer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (customer) {
    return (
      <div className="flex items-center justify-between gap-2 rounded border border-primary/30 bg-primary-soft/50 p-2 text-sm" data-testid="rpos-customer">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 font-medium"><UserRound className="h-4 w-4 text-primary" aria-hidden="true" />{customer.name}</p>
          <p className="flex flex-wrap gap-x-3 text-xs text-muted">
            <span dir="ltr">{customer.phone}</span>
            <span>رصيد: <span className="lb-numeric text-fg">{money(customer.storeCreditCents)}</span></span>
            {customer.loyaltyEnabled && <span className="flex items-center gap-1"><Sparkles className="h-3 w-3 text-primary" aria-hidden="true" /><span className="lb-numeric text-fg">{customer.loyaltyPoints}</span> نقطة</span>}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => onChange(null)} aria-label="إزالة العميل"><X className="h-4 w-4" /></Button>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          start(async () => {
            const r = await lookupCustomerAction(scope, { phone });
            if (!r.ok) { setError(r.error); setResults(null); return; }
            if (r.data.length === 1) { onChange(r.data[0]!); setPhone(''); setResults(null); return; }
            setResults(r.data);
            if (r.data.length === 0) setError('لا يوجد عميل بهذا الرقم.');
          });
        }}
      >
        <Input aria-label="هاتف العميل" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="هاتف العميل (اختياري)" inputMode="tel" dir="ltr" className="h-9" />
        <Button type="submit" size="sm" variant="outline" disabled={pending || phone.trim().length < 7}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <UserRound className="h-4 w-4" aria-hidden="true" />} بحث
        </Button>
      </form>
      {error && <p className="text-xs text-danger">{error}</p>}
      {results && results.length > 1 && (
        <ul className="space-y-1">
          {results.map((c) => (
            <li key={c.customerId}>
              <button type="button" className="w-full rounded border border-line px-2 py-1 text-start text-sm hover:bg-surface"
                onClick={() => { onChange(c); setPhone(''); setResults(null); }}>
                {c.name} <span className="text-xs text-muted">· رصيد {money(c.storeCreditCents)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
