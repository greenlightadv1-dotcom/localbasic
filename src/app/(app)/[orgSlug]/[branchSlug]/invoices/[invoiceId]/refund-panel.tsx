'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Undo2 } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { useApproval } from '@/components/patterns/approval-dialog';
import { formatMoney } from '@/lib/money';
import { fromCents, toCents } from '@/lib/amount-input';
import type { ApprovalAction } from '@/modules/restaurant/approvals/schema';
import { refundPaymentAction } from '../../risk-actions';

const METHODS = { cash: 'نقدي', card: 'بطاقة', transfer: 'تحويل', wallet: 'محفظة', other: 'أخرى' } as const;

/**
 * Refund part or all of what was paid (0108). Every refund is a risk event on
 * the person's score; past their daily refund cap a manager's PIN covers the
 * excess and is recorded with it.
 */
export function RefundPanel({ scope, invoiceId, paidCents, currency }: {
  scope: { organizationSlug: string; branchSlug: string }; invoiceId: string; paidCents: number; currency: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const approval = useApproval(scope);
  const [pending, start] = useTransition();
  const [amount, setAmount] = useState(fromCents(paidCents));
  const [method, setMethod] = useState<keyof typeof METHODS>('cash');
  const [reason, setReason] = useState('');

  async function run(): Promise<void> {
    const cents = toCents(amount);
    if (!cents || cents > paidCents) { toast.error('المبلغ غير صالح'); return; }
    const r = await refundPaymentAction(scope, { invoiceId, amountCents: cents, method, reason });
    if (!r.ok) {
      if (r.code === 'approval_required') {
        approval.request((r.approval?.action ?? 'refund.daily_limit') as ApprovalAction, invoiceId, r.approval?.amount ?? cents, run);
        return;
      }
      toast.error(r.error); return;
    }
    toast.success(`تم استرداد ${formatMoney(r.data.refundCents, currency)}`);
    setReason('');
    router.refresh();
  }

  return (
    <Card className="print:hidden">
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Undo2 className="h-4 w-4" aria-hidden="true" /> استرداد</CardTitle></CardHeader>
      <CardBody>
        <form onSubmit={(e) => { e.preventDefault(); start(run); }} className="space-y-2" aria-label="استرداد">
          <div className="flex gap-2">
            <Input aria-label="مبلغ الاسترداد" dir="ltr" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="refund-amount" />
            <Select aria-label="طريقة الاسترداد" value={method} onChange={(e) => setMethod(e.target.value as keyof typeof METHODS)}>
              {Object.entries(METHODS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </div>
          <Input aria-label="سبب الاسترداد" placeholder="سبب الاسترداد (مطلوب)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
          <p className="text-xs text-muted">يخرج المبلغ من الخزينة ويُسجَّل باسمك في مراجعة المخاطر.</p>
          <Button type="submit" size="sm" variant="secondary" disabled={pending || reason.trim().length < 2 || !amount} data-testid="refund-submit">استرداد</Button>
        </form>
      </CardBody>
      {approval.dialog}
    </Card>
  );
}
