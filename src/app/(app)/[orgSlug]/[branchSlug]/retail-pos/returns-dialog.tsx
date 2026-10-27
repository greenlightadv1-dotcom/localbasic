'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Banknote, CreditCard, Loader2, PackageX, Repeat, Search, ShieldCheck, Undo2, Wallet, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { useApproval } from '@/components/patterns/approval-dialog';
import { formatMoney } from '@/lib/money';
import { toCents, fromCents } from '@/lib/amount-input';
import { cn } from '@/lib/cn';
import type { ApprovalAction } from '@/modules/restaurant/approvals/schema';
import type { PosCustomer, Receipt, ReturnResult } from '@/modules/retail/operations/service';
import { lookupReceiptAction, processReturnAction } from './actions';
import type { CartLine } from './retail-pos-terminal';

type Scope = { organizationSlug: string; branchSlug: string };
type Resolution = 'cash' | 'card' | 'store_credit' | 'exchange';
type Condition = 'resellable' | 'damaged';
type Pick = { quantity: string; condition: Condition; note: string };

export type ReturnOutcome = { exchanged: boolean; message: string };

const RESOLUTIONS: { key: Resolution; label: string; hint: string; icon: typeof Banknote }[] = [
  { key: 'cash', label: 'نقدي', hint: 'يحتاج رمز المدير', icon: Banknote },
  { key: 'card', label: 'بطاقة', hint: 'إلى نفس البطاقة', icon: CreditCard },
  { key: 'store_credit', label: 'رصيد متجر', hint: 'يُضاف لحساب العميل', icon: Wallet },
  { key: 'exchange', label: 'استبدال', hint: 'بأصناف السلة الحالية', icon: Repeat },
];

/**
 * Receipt-based returns. The cashier finds the receipt, picks what came back
 * and in what condition, and chooses how the customer is paid back.
 *
 * Cash is the one the drawer feels, so the database refuses it (LB403,
 * 'retail.cashback') until a manager approves on this device; the PIN dialog
 * opens in place and the same return is resubmitted with the grant. Values
 * shown are the database's own per-unit refund (invoice discounts included).
 */
export function ReturnsDialog({
  open, scope, currency, cart, cartTotalCents, attachedCustomer, onClose, onDone,
}: {
  open: boolean;
  scope: Scope;
  currency: string;
  cart: CartLine[];
  cartTotalCents: number;
  attachedCustomer: PosCustomer | null;
  onClose: () => void;
  onDone: (outcome: ReturnOutcome) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const numberRef = useRef<HTMLInputElement>(null);
  const approval = useApproval(scope);
  const money = (c: number) => formatMoney(c, currency);

  const [number, setNumber] = useState('');
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [resolution, setResolution] = useState<Resolution>('cash');
  const [reason, setReason] = useState('');
  const [exchangeTender, setExchangeTender] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReturnResult | null>(null);
  const [finding, startFinding] = useTransition();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { d.showModal(); requestAnimationFrame(() => numberRef.current?.focus()); }
    if (!open && d.open) d.close();
    if (!open) {
      setNumber(''); setReceipt(null); setPicks({}); setResolution('cash'); setReason('');
      setExchangeTender(''); setError(null); setResult(null);
    }
  }, [open]);

  const customer = receipt?.customer ?? (attachedCustomer ? { id: attachedCustomer.customerId, name: attachedCustomer.name, phone: attachedCustomer.phone } : null);

  const selected = useMemo(() => {
    if (!receipt) return [];
    return receipt.lines.flatMap((l) => {
      const p = picks[l.variantId];
      const q = p ? Number(p.quantity) : 0;
      return q > 0 ? [{ line: l, quantity: q, condition: p!.condition, note: p!.note.trim() }] : [];
    });
  }, [receipt, picks]);

  const overLimit = selected.some((s) => s.quantity > s.line.quantity - s.line.returned + 1e-9 || !Number.isFinite(s.quantity));
  const refundCents = selected.reduce((sum, s) => sum + Math.round(s.line.unitRefundCents * s.quantity), 0);
  const exchangeDue = Math.max(cartTotalCents - refundCents, 0);

  useEffect(() => { if (resolution === 'exchange') setExchangeTender(exchangeDue > 0 ? fromCents(exchangeDue) : ''); }, [resolution, exchangeDue]);

  const blocker =
    !receipt ? null
    : selected.length === 0 ? 'اختر صنفًا واحدًا على الأقل.'
    : overLimit ? 'الكمية أكبر من المتاح للإرجاع.'
    : (resolution === 'store_credit' || resolution === 'exchange') && !customer ? 'رصيد المتجر والاستبدال يحتاجان عميلًا: اربط العميل في السلة أولًا.'
    : resolution === 'exchange' && cart.length === 0 ? 'أضف أصناف الاستبدال إلى السلة أولًا.'
    : resolution === 'exchange' && exchangeDue > 0 && (toCents(exchangeTender) ?? -1) < exchangeDue ? 'المبلغ المدفوع للفرق أقل من المطلوب.'
    : null;

  function find(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    startFinding(async () => {
      const r = await lookupReceiptAction(scope, { number });
      if (!r.ok) { setError(r.error); return; }
      if (!r.data) { setError('لا توجد فاتورة بهذا الرقم في هذا الفرع.'); setReceipt(null); return; }
      setReceipt(r.data);
      setPicks({});
      if (r.data.status === 'issued' || r.data.paidCents <= 0) setResolution('store_credit');
    });
  }

  function setPick(variantId: string, patch: Partial<Pick>) {
    setPicks((all) => ({ ...all, [variantId]: { quantity: '', condition: 'resellable', note: '', ...all[variantId], ...patch } }));
  }

  async function submit(): Promise<void> {
    if (!receipt || blocker) return;
    setSubmitting(true);
    setError(null);
    const r = await processReturnAction(scope, {
      invoiceId: receipt.invoiceId,
      items: selected.map((s) => ({ variantId: s.line.variantId, quantity: s.quantity, condition: s.condition, note: s.note || undefined })),
      resolution,
      customerId: customer?.id ?? null,
      reason: reason.trim() || undefined,
      exchangeItems: resolution === 'exchange'
        ? cart.map((l) => ({ variantId: l.item.variantId, quantity: l.quantity, discountCents: 0 }))
        : undefined,
      exchangeMethod: 'cash',
      exchangeTenderedCents: resolution === 'exchange' ? Math.max(toCents(exchangeTender) ?? 0, 0) : 0,
    });
    setSubmitting(false);
    if (!r.ok) {
      if (r.code === 'approval_required') {
        // The manager approves on this device; the same return then runs again.
        approval.request((r.approval?.action ?? 'retail.cashback') as ApprovalAction, receipt.invoiceId, r.approval?.amount ?? refundCents, submit);
        return;
      }
      setError(r.code === 'forbidden' || r.code === 'not_found' ? 'لا تملك صلاحية هذا المرتجع.' : r.error);
      return;
    }
    setResult(r.data);
  }

  function finish() {
    if (!result) return;
    const message =
      result.refundCents > 0 ? `مرتجع ${result.number}: رُدّ ${money(result.refundCents)}.`
      : result.exchangeInvoiceId ? `مرتجع ${result.number}: تم الاستبدال بقيمة ${money(result.valueCents)}.`
      : `مرتجع ${result.number}: أضيف ${money(result.storeCreditCents)} لرصيد العميل.`;
    onDone({ exchanged: !!result.exchangeInvoiceId, message });
  }

  return (
    <dialog
      ref={ref}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      aria-labelledby="returns-title"
      className="w-[min(46rem,calc(100vw-1rem))] rounded-lg border border-line bg-elevated p-0 text-fg backdrop:bg-fg/40"
      data-testid="returns-dialog"
    >
      <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 id="returns-title" className="flex items-center gap-2 text-base font-bold">
            <Undo2 className="h-5 w-5 text-primary" aria-hidden="true" /> مرتجع بالفاتورة
          </h2>
          <Button size="icon" variant="ghost" onClick={onClose} aria-label="إغلاق"><X className="h-5 w-5" /></Button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {result ? (
            <div className="space-y-3 py-4 text-center">
              <Badge tone="success">تم المرتجع</Badge>
              <p className="text-lg font-bold">{result.number}</p>
              <dl className="mx-auto max-w-xs space-y-1 text-sm">
                <div className="flex justify-between"><dt className="text-muted">قيمة المرتجع</dt><dd className="lb-numeric">{money(result.valueCents)}</dd></div>
                {result.refundCents > 0 && <div className="flex justify-between"><dt className="text-muted">مردود</dt><dd className="lb-numeric font-semibold">{money(result.refundCents)}</dd></div>}
                {result.storeCreditCents > 0 && <div className="flex justify-between"><dt className="text-muted">رصيد متجر</dt><dd className="lb-numeric font-semibold">{money(result.storeCreditCents)}</dd></div>}
              </dl>
              {result.exchangeInvoiceId && <p className="text-sm text-muted">صدرت فاتورة الاستبدال وأفرغت السلة.</p>}
            </div>
          ) : (
            <>
              <form onSubmit={find} className="flex gap-2">
                <Input ref={numberRef} aria-label="رقم الفاتورة" value={number} onChange={(e) => setNumber(e.target.value)}
                  placeholder="رقم الفاتورة (INV-…)" dir="ltr" className="h-11" data-testid="returns-number" />
                <Button type="submit" disabled={finding || !number.trim()}>
                  {finding ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Search className="h-4 w-4" aria-hidden="true" />} بحث
                </Button>
              </form>

              {error && <Alert tone="danger">{error}</Alert>}

              {receipt && (
                <>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded bg-surface px-3 py-2 text-sm">
                    <span className="font-semibold lb-numeric">{receipt.number}</span>
                    {receipt.issuedAt && <span className="text-muted">{new Date(receipt.issuedAt).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' })}</span>}
                    <span>الإجمالي <span className="lb-numeric">{money(receipt.totalCents)}</span></span>
                    <span>{customer ? customer.name : <span className="text-muted">بدون عميل</span>}</span>
                  </div>

                  <ul className="space-y-2" aria-label="أصناف الفاتورة">
                    {receipt.lines.map((l) => {
                      const left = Math.max(l.quantity - l.returned, 0);
                      const p = picks[l.variantId];
                      return (
                        <li key={l.variantId} className={cn('rounded border p-3', left === 0 ? 'border-line opacity-60' : 'border-line')}>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-sm font-medium">{l.description}</p>
                              <p className="text-xs text-muted">
                                مباع <span className="lb-numeric">{l.quantity}</span> · مرتجع سابقًا <span className="lb-numeric">{l.returned}</span> · قيمة الوحدة <span className="lb-numeric">{money(l.unitRefundCents)}</span>
                              </p>
                            </div>
                            {left > 0 ? (
                              <div className="flex items-center gap-2">
                                <Input aria-label={`كمية مرتجع ${l.description}`} value={p?.quantity ?? ''} onChange={(e) => setPick(l.variantId, { quantity: e.target.value })}
                                  inputMode="decimal" dir="ltr" placeholder="0" className="h-9 w-20 text-center" />
                                <span className="text-xs text-muted">من {left}</span>
                              </div>
                            ) : <Badge>مرتجع بالكامل</Badge>}
                          </div>
                          {p && Number(p.quantity) > 0 && (
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <div className="flex overflow-hidden rounded border border-line text-sm" role="radiogroup" aria-label="حالة الصنف">
                                {(['resellable', 'damaged'] as const).map((c) => (
                                  <button key={c} type="button" role="radio" aria-checked={p.condition === c} onClick={() => setPick(l.variantId, { condition: c })}
                                    className={cn('flex items-center gap-1 px-3 py-1.5', p.condition === c ? (c === 'damaged' ? 'bg-danger text-white' : 'bg-primary text-primary-fg') : 'bg-elevated hover:bg-surface')}>
                                    {c === 'damaged' && <PackageX className="h-4 w-4" aria-hidden="true" />}
                                    {c === 'resellable' ? 'صالح للبيع' : 'تالف'}
                                  </button>
                                ))}
                              </div>
                              {p.condition === 'damaged' && (
                                <Input aria-label="وصف التلف" value={p.note} onChange={(e) => setPick(l.variantId, { note: e.target.value })} placeholder="وصف التلف" maxLength={300} className="h-8 flex-1" />
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>

                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium">طريقة الرد</legend>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {RESOLUTIONS.map(({ key, label, hint, icon: Icon }) => {
                        const disabled = ((key === 'store_credit' || key === 'exchange') && !customer)
                          || ((key === 'cash' || key === 'card') && receipt.paidCents <= 0)
                          || (key === 'exchange' && cart.length === 0);
                        return (
                          <button key={key} type="button" disabled={disabled} aria-pressed={resolution === key} onClick={() => setResolution(key)}
                            className={cn('flex flex-col items-start gap-1 rounded border p-3 text-start text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                              resolution === key ? 'border-primary bg-primary-soft' : 'border-line bg-elevated hover:bg-surface')}>
                            <span className="flex items-center gap-1.5 font-medium"><Icon className="h-4 w-4" aria-hidden="true" />{label}</span>
                            <span className="text-xs text-muted">{hint}</span>
                          </button>
                        );
                      })}
                    </div>
                  </fieldset>

                  {resolution === 'cash' && (
                    <p className="flex items-center gap-2 rounded bg-warn/10 px-3 py-2 text-xs text-warn">
                      <ShieldCheck className="h-4 w-4" aria-hidden="true" /> رد النقدية من الدرج يحتاج موافقة المدير برمزه.
                    </p>
                  )}

                  {resolution === 'exchange' && (
                    <div className="space-y-2 rounded border border-line p-3 text-sm">
                      <p className="font-medium">الأصناف الجديدة من السلة</p>
                      <ul className="text-xs text-muted">
                        {cart.map((l) => <li key={l.item.variantId}>{l.item.productName} × <span className="lb-numeric">{l.quantity}</span></li>)}
                      </ul>
                      <div className="flex justify-between"><span className="text-muted">قيمة السلة</span><span className="lb-numeric">{money(cartTotalCents)}</span></div>
                      <div className="flex justify-between"><span className="text-muted">قيمة المرتجع</span><span className="lb-numeric">− {money(refundCents)}</span></div>
                      {exchangeDue > 0 ? (
                        <label className="flex items-center justify-between gap-2">
                          <span>الفرق نقدًا <span className="lb-numeric font-semibold">{money(exchangeDue)}</span></span>
                          <Input aria-label="المبلغ المدفوع للفرق" value={exchangeTender} onChange={(e) => setExchangeTender(e.target.value)} inputMode="decimal" dir="ltr" className="h-9 w-28" />
                        </label>
                      ) : (
                        <p className="text-xs text-success">يبقى للعميل <span className="lb-numeric">{money(refundCents - cartTotalCents)}</span> رصيدًا في المتجر.</p>
                      )}
                    </div>
                  )}

                  <Input aria-label="سبب المرتجع" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="سبب المرتجع (اختياري)" maxLength={300} />
                </>
              )}
            </>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-line px-5 py-4">
          {result ? (
            <Button block onClick={finish} autoFocus>تم</Button>
          ) : (
            <>
              <div className="text-sm">
                {receipt && <>قيمة المرتجع <span className="lb-numeric text-lg font-bold">{money(refundCents)}</span></>}
                {blocker && receipt && <p className="text-xs text-warn">{blocker}</p>}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={onClose} disabled={submitting}>إلغاء</Button>
                <Button onClick={() => void submit()} disabled={!receipt || !!blocker || submitting} data-testid="returns-submit">
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Undo2 className="h-4 w-4" aria-hidden="true" />} تنفيذ المرتجع
                </Button>
              </div>
            </>
          )}
        </footer>
      </div>
      {approval.dialog}
    </dialog>
  );
}
