'use client';

import { useState, useTransition } from 'react';
import { Banknote, CheckCircle2, CreditCard, Landmark, Smartphone, Users, Wallet } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Field, Input } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { useApproval } from '@/components/patterns/approval-dialog';
import { cn } from '@/lib/cn';
import { formatMoney } from '@/lib/money';
import { fromCents, toCents } from '@/lib/amount-input';
import type { ApprovalAction } from '@/modules/restaurant/approvals/schema';
import { payOrderAction, setOrderStatusAction } from '../restaurant-actions';
import { PrintReceiptButton } from '../print-receipt-button';
import type { Scope } from './shared';

const METHODS = [
  { id: 'cash', label: 'نقدي', icon: Banknote },
  { id: 'card', label: 'بطاقة', icon: CreditCard },
  { id: 'wallet', label: 'محفظة', icon: Smartphone },
  { id: 'transfer', label: 'تحويل', icon: Landmark },
] as const;
type Method = (typeof METHODS)[number]['id'];

export type CheckoutOrder = { id: string; number: string; status: string; totalCents: number; paidCents: number; label: string };

/**
 * Fast checkout for one check. A payment smaller than what is due is a
 * partial payment: the order stays open for the next one, which is how a
 * check is split evenly between guests. The database prices the order and
 * decides the change; a manual discount asks for a manager's PIN (0103).
 */
export function CheckoutModal({
  scope, currency, order, canDiscount, onClose, onPaid,
}: {
  scope: Scope; currency: string; order: CheckoutOrder; canDiscount: boolean;
  onClose: () => void; onPaid: (closed: boolean) => void;
}) {
  const toast = useToast();
  const approval = useApproval(scope);
  const [pending, start] = useTransition();
  const due = Math.max(0, order.totalCents - order.paidCents);
  const [method, setMethod] = useState<Method>('cash');
  const [amount, setAmount] = useState(fromCents(due));
  const [discount, setDiscount] = useState('');
  const [guests, setGuests] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ invoiceId: string; paid: number; due: number; change: number } | null>(null);

  const discountCents = canDiscount ? toCents(discount || '0') ?? -1 : 0;
  const payable = Math.max(0, due - Math.max(0, discountCents));
  const share = guests > 1 ? Math.ceil(payable / guests) : payable;
  const tendered = toCents(amount || '0') ?? -1;
  const change = method === 'cash' && tendered > payable ? tendered - payable : 0;

  function quick(cents: number) { setAmount(fromCents(cents)); }
  const roundUps = [...new Set([5000, 10000, 20000, 50000].map((s) => Math.ceil(payable / s) * s).filter((v) => v > payable))].slice(0, 3);

  function pay() {
    setError(null);
    if (discountCents < 0) { setError('قيمة الخصم غير صحيحة'); return; }
    if (tendered <= 0) { setError('أدخل المبلغ المستلم'); return; }
    if (method !== 'cash' && tendered > payable) { setError('الدفع بالبطاقة أو المحفظة لا يتجاوز المستحق'); return; }
    const run = async (): Promise<void> => {
      const r = await payOrderAction(scope, {
        orderId: order.id, method, tenderedCents: tendered, discountCents: Math.max(0, discountCents),
      });
      if (!r.ok) {
        if (r.code === 'approval_required') {
          const gate = (r.approval?.action ?? 'order.discount') as ApprovalAction;
          approval.request(gate, order.id, r.approval?.amount ?? discountCents, run);
          return;
        }
        setError(r.error);
        return;
      }
      let closed = false;
      // A settled, served check is closed out, freeing the table for cleaning.
      if (r.data.dueCents === 0 && order.status === 'served') {
        const c = await setOrderStatusAction(scope, { orderId: order.id, status: 'completed' });
        closed = c.ok;
      }
      setResult({ invoiceId: r.data.invoiceId, paid: r.data.paidCents, due: r.data.dueCents, change: r.data.changeCents });
      toast.success(r.data.dueCents === 0 ? `تم تحصيل الطلب #${order.number} بالكامل` : `دفعة جزئية — المتبقي ${formatMoney(r.data.dueCents, currency)}`);
      onPaid(closed);
      if (r.data.dueCents > 0) { setAmount(fromCents(guests > 1 ? Math.min(share, r.data.dueCents) : r.data.dueCents)); setDiscount(''); }
    };
    start(run);
  }

  return (
    <Modal open title={`تحصيل — ${order.label}`} description={`طلب #${order.number}`} icon={Wallet} size="md"
      onClose={onClose} busy={pending} testId="checkout-modal"
      footer={result && result.due === 0 ? (
        <div className="flex w-full justify-between gap-2">
          <PrintReceiptButton organizationSlug={scope.organizationSlug} branchSlug={scope.branchSlug} invoiceId={result.invoiceId} />
          <Button onClick={onClose}>تم</Button>
        </div>
      ) : (
        <div className="flex w-full justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={pending}>إغلاق</Button>
          <Button onClick={pay} disabled={pending || due === 0} data-testid="checkout-pay">
            تحصيل {tendered > 0 ? formatMoney(Math.min(tendered, payable), currency) : ''}
          </Button>
        </div>
      )}>
      {result && result.due === 0 ? (
        <div className="space-y-3 text-center" data-testid="checkout-done">
          <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-600" aria-hidden="true" />
          <p className="text-lg font-bold">تم التحصيل بالكامل</p>
          {result.change > 0 && <p className="text-2xl font-black lb-numeric">الباقي للعميل {formatMoney(result.change, currency)}</p>}
        </div>
      ) : (
        <div className="space-y-4">
          <dl className="grid grid-cols-3 gap-2 rounded border border-line p-3 text-center text-sm">
            <div><dt className="text-xs text-muted">الإجمالي</dt><dd className="font-bold lb-numeric">{formatMoney(order.totalCents, currency)}</dd></div>
            <div><dt className="text-xs text-muted">المدفوع</dt><dd className="font-bold lb-numeric">{formatMoney(result?.paid ?? order.paidCents, currency)}</dd></div>
            <div><dt className="text-xs text-muted">المستحق</dt><dd className="text-lg font-black text-primary lb-numeric">{formatMoney(result?.due ?? payable, currency)}</dd></div>
          </dl>

          <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="طريقة الدفع">
            {METHODS.map((m) => (
              <button key={m.id} type="button" role="radio" aria-checked={method === m.id} onClick={() => setMethod(m.id)}
                className={cn('flex flex-col items-center gap-1 rounded border p-2 text-xs font-semibold',
                  method === m.id ? 'border-primary bg-primary-soft text-primary' : 'border-line')}>
                <m.icon className="h-5 w-5" aria-hidden="true" /> {m.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded border border-line p-2 text-sm">
            <Users className="h-4 w-4 text-muted" aria-hidden="true" />
            <span>تقسيم بالتساوي على</span>
            <input type="number" min={1} max={30} value={guests} dir="ltr" aria-label="عدد الأشخاص"
              onChange={(e) => { const g = Math.min(Math.max(Number(e.target.value) || 1, 1), 30); setGuests(g); setAmount(fromCents(g > 1 ? Math.ceil(payable / g) : payable)); }}
              className="h-8 w-16 rounded border border-line bg-elevated px-2 text-center lb-numeric" />
            <span>شخص</span>
            {guests > 1 && <span className="ms-auto font-semibold lb-numeric">الحصة {formatMoney(share, currency)}</span>}
          </div>

          <Field label={method === 'cash' ? 'المبلغ المستلم' : 'مبلغ هذه الدفعة'}>
            {(p) => <Input {...p} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" dir="ltr" className="text-lg lb-numeric" data-testid="checkout-amount" />}
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => quick(payable)}>المبلغ بالضبط</Button>
            {method === 'cash' && roundUps.map((v) => (
              <Button key={v} size="sm" variant="outline" onClick={() => quick(v)}><span className="lb-numeric">{formatMoney(v, currency)}</span></Button>
            ))}
          </div>
          {change > 0 && <p className="text-sm font-semibold">الباقي للعميل: <span className="lb-numeric">{formatMoney(change, currency)}</span></p>}
          {tendered > 0 && tendered < payable && <p className="text-xs text-muted">دفعة جزئية؛ يبقى الطلب مفتوحًا حتى يُسدَّد الباقي.</p>}

          {canDiscount && (
            <Field label="خصم يدوي (اختياري)" hint="الخصم فوق حد الصلاحية يطلب رمز موافقة المدير.">
              {(p) => <Input {...p} value={discount} onChange={(e) => setDiscount(e.target.value)} inputMode="decimal" dir="ltr" placeholder="0.00" />}
            </Field>
          )}
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      )}
      {approval.dialog}
    </Modal>
  );
}
