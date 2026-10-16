'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Printer } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Field, Input, Select } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { useApproval } from '@/components/patterns/approval-dialog';
import { formatMoney } from '@/lib/money';
import { fromCents, toCents } from '@/lib/amount-input';
import { cn } from '@/lib/cn';
import type { HouseAccount, Statement } from '@/modules/restaurant/crm/service';
import { accountAdjustAction, accountPaymentAction, saveAccountAction } from '../actions';

type Scope = { organizationSlug: string; branchSlug: string };
const KIND = { charge: 'فاتورة آجلة', payment: 'سداد', adjustment: 'تسوية' } as const;
const METHOD = { cash: 'نقدي', card: 'بطاقة', transfer: 'تحويل بنكي', wallet: 'محفظة', other: 'أخرى' } as const;
const day = (iso: string) => new Date(iso).toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' });

/**
 * A printable statement (opening balance, every movement with a running
 * balance, closing balance) plus the desk: receive a payment, post a
 * PIN-approved adjustment, change the credit terms.
 */
export function StatementView({ scope, basePath, organizationName, currency, statement, account }: {
  scope: Scope; basePath: string; organizationName: string; currency: string; statement: Statement; account: HouseAccount;
}) {
  const router = useRouter();
  const toast = useToast();
  const approval = useApproval(scope);
  const [pending, start] = useTransition();
  const money = (c: number) => formatMoney(c, currency);
  const [range, setRange] = useState({ from: statement.from, to: statement.to });
  const [pay, setPay] = useState({ amount: '', method: 'transfer' as keyof typeof METHOD, reference: '' });
  const [adj, setAdj] = useState({ amount: '', note: '' });
  const [terms, setTerms] = useState({ limit: fromCents(account.limitCents), days: String(account.termsDays), contact: account.contact ?? '', isActive: account.isActive });
  const customerId = statement.customer.id;

  function receive(e: React.FormEvent) {
    e.preventDefault();
    const cents = toCents(pay.amount);
    if (!cents) { toast.error('المبلغ غير صالح'); return; }
    start(async () => {
      const r = await accountPaymentAction(scope, { customerId, amountCents: cents, method: pay.method, reference: pay.reference || undefined });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success('تم تسجيل السداد'); setPay({ ...pay, amount: '', reference: '' }); router.refresh();
    });
  }

  async function runAdjust(): Promise<void> {
    const cents = toCents(adj.amount, { allowNegative: true });
    if (!cents) { toast.error('المبلغ غير صالح'); return; }
    const r = await accountAdjustAction(scope, { customerId, amountCents: cents, note: adj.note });
    if (!r.ok) {
      if (r.code === 'approval_required') { approval.request('account.adjust', customerId, Math.abs(cents), runAdjust); return; }
      toast.error(r.error); return;
    }
    toast.success('تمت التسوية'); setAdj({ amount: '', note: '' }); router.refresh();
  }

  function saveTerms(e: React.FormEvent) {
    e.preventDefault();
    const limit = toCents(terms.limit || '0');
    if (limit === null) { toast.error('حد الائتمان غير صالح'); return; }
    start(async () => {
      const r = await saveAccountAction(scope, { customerId, limitCents: limit, termsDays: Number(terms.days) || 0, contact: terms.contact || undefined, isActive: terms.isActive });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success('تم حفظ شروط الحساب'); router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Link href={basePath} className="flex items-center gap-1 text-sm text-primary"><ArrowRight className="h-4 w-4" aria-hidden="true" /> كل الحسابات</Link>
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); router.push(`?from=${range.from}&to=${range.to}`); }}>
          <Input aria-label="من" type="date" dir="ltr" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} className="w-40" />
          <Input aria-label="إلى" type="date" dir="ltr" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} className="w-40" />
          <Button type="submit" size="sm" variant="secondary">عرض</Button>
          <Button type="button" size="sm" onClick={() => window.print()} data-testid="print-statement"><Printer className="h-4 w-4" aria-hidden="true" /> طباعة</Button>
        </form>
      </div>

      <Card className="print:border-0 print:shadow-none">
        <CardBody className="space-y-4" data-testid="statement">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-xs text-muted">{organizationName}</p>
              <h1 className="text-xl font-bold">كشف حساب — {statement.customer.name}</h1>
              <p className="text-sm text-muted">{statement.customer.phone && <span dir="ltr">{statement.customer.phone}</span>}{account.contact ? ` · ${account.contact}` : ''}</p>
              <p className="text-sm">الفترة من {day(statement.from)} إلى {day(statement.to)}</p>
            </div>
            <div className="text-end text-sm">
              <p>حد الائتمان: <span className="lb-numeric">{statement.creditLimitCents ? money(statement.creditLimitCents) : '—'}</span></p>
              <p>مهلة السداد: {statement.termsDays} يوم</p>
              <p className="text-lg font-bold">الرصيد الحالي: <span className="lb-numeric">{money(statement.balanceNowCents)}</span></p>
              {account.overdueCents > 0 && <Badge tone="danger">متأخر {money(account.overdueCents)}</Badge>}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-line text-xs text-muted">
                <tr><th className="p-2 text-start">التاريخ</th><th className="p-2 text-start">البيان</th><th className="p-2 text-end">مدين</th><th className="p-2 text-end">دائن</th><th className="p-2 text-end">الرصيد</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                <tr className="bg-surface"><td className="p-2" colSpan={4}>رصيد أول المدة</td><td className="lb-numeric p-2 font-bold">{money(statement.openingCents)}</td></tr>
                {statement.entries.map((e) => (
                  <tr key={e.id}>
                    <td className="p-2 whitespace-nowrap">{day(e.at)}</td>
                    <td className="p-2">
                      {KIND[e.kind]}{e.invoiceNumber ? ` — فاتورة ${e.invoiceNumber}` : ''}{e.orderNumber ? ` (طلب #${e.orderNumber})` : ''}
                      {e.note && <span className="block text-xs text-muted">{e.note}</span>}
                    </td>
                    <td className="lb-numeric p-2">{e.amountCents > 0 ? money(e.amountCents) : ''}</td>
                    <td className="lb-numeric p-2">{e.amountCents < 0 ? money(-e.amountCents) : ''}</td>
                    <td className={cn('lb-numeric p-2', e.balanceCents < 0 && 'text-success')}>{money(e.balanceCents)}</td>
                  </tr>
                ))}
                {statement.entries.length === 0 && <tr><td colSpan={5} className="p-4 text-center text-muted">لا حركات في هذه الفترة.</td></tr>}
                <tr className="bg-surface font-bold"><td className="p-2" colSpan={4}>رصيد آخر المدة</td><td className="lb-numeric p-2">{money(statement.closingCents)}</td></tr>
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      <div className="grid gap-4 md:grid-cols-3 print:hidden">
        <Card>
          <CardHeader><CardTitle>استلام سداد</CardTitle></CardHeader>
          <CardBody>
            <form onSubmit={receive} className="space-y-2">
              <Input aria-label="المبلغ" placeholder="المبلغ" dir="ltr" inputMode="decimal" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} data-testid="pay-amount" />
              <Select aria-label="طريقة الدفع" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value as keyof typeof METHOD })}>
                {Object.entries(METHOD).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </Select>
              <Input aria-label="المرجع" placeholder="رقم الشيك / التحويل" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} maxLength={120} />
              <p className="text-xs text-muted">يُوزّع على أقدم الفواتير أولًا ويدخل الخزينة.</p>
              <Button type="submit" size="sm" disabled={pending || !pay.amount} data-testid="pay-submit">تسجيل السداد</Button>
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>تسوية (إشعار دائن / مدين)</CardTitle></CardHeader>
          <CardBody>
            <form onSubmit={(e) => { e.preventDefault(); start(runAdjust); }} className="space-y-2">
              <Input aria-label="المبلغ" placeholder="سالب = خصم من المديونية" dir="ltr" inputMode="decimal" value={adj.amount} onChange={(e) => setAdj({ ...adj, amount: e.target.value })} />
              <Input aria-label="السبب" placeholder="السبب (مطلوب)" value={adj.note} onChange={(e) => setAdj({ ...adj, note: e.target.value })} maxLength={300} />
              <p className="text-xs text-muted">تحتاج موافقة المدير برمز PIN وتُسجّل في سجل النشاط.</p>
              <Button type="submit" size="sm" variant="secondary" disabled={pending || !adj.amount || !adj.note.trim()}>تسجيل التسوية</Button>
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>شروط الحساب</CardTitle></CardHeader>
          <CardBody>
            <form onSubmit={saveTerms} className="space-y-2">
              <Field label="حد الائتمان">{(p) => <Input {...p} dir="ltr" inputMode="decimal" value={terms.limit} onChange={(e) => setTerms({ ...terms, limit: e.target.value })} />}</Field>
              <Field label="مهلة السداد (يوم)">{(p) => <Input {...p} type="number" min={0} max={365} dir="ltr" value={terms.days} onChange={(e) => setTerms({ ...terms, days: e.target.value })} />}</Field>
              <Field label="المسؤول">{(p) => <Input {...p} value={terms.contact} onChange={(e) => setTerms({ ...terms, contact: e.target.value })} maxLength={120} />}</Field>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={terms.isActive} onChange={(e) => setTerms({ ...terms, isActive: e.target.checked })} /> الحساب فعّال (يقبل فواتير آجلة)</label>
              <Button type="submit" size="sm" variant="secondary" disabled={pending}>حفظ</Button>
            </form>
          </CardBody>
        </Card>
      </div>
      {approval.dialog}
    </div>
  );
}
