'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Building2, Plus } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Field, Input } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { formatMoney } from '@/lib/money';
import { toCents } from '@/lib/amount-input';
import { cn } from '@/lib/cn';
import type { HouseAccount } from '@/modules/restaurant/crm/service';
import { saveAccountAction } from './actions';

type Scope = { organizationSlug: string; branchSlug: string };

export function AccountsView({ scope, basePath, currency, accounts }: { scope: Scope; basePath: string; currency: string; accounts: HouseAccount[] }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [form, setForm] = useState<{ name: string; phone: string; contact: string; limit: string; terms: string } | null>(null);
  const money = (c: number) => formatMoney(c, currency);
  const total = accounts.reduce((s, a) => s + a.balanceCents, 0);
  const overdue = accounts.reduce((s, a) => s + a.overdueCents, 0);

  function create(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    const limit = toCents(form.limit || '0');
    if (limit === null) { toast.error('حد الائتمان غير صالح'); return; }
    start(async () => {
      const r = await saveAccountAction(scope, { customerId: null, name: form.name, phone: form.phone, contact: form.contact || undefined, limitCents: limit, termsDays: Number(form.terms) || 0, isActive: true });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success('تم فتح الحساب');
      router.push(`${basePath}/${r.data.customerId}`);
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card><CardBody><p className="text-xs text-muted">عدد الحسابات</p><p className="lb-numeric text-xl font-bold">{accounts.length}</p></CardBody></Card>
        <Card><CardBody><p className="text-xs text-muted">إجمالي المستحق</p><p className="lb-numeric text-xl font-bold">{money(total)}</p></CardBody></Card>
        <Card><CardBody><p className="text-xs text-muted">متأخرات</p><p className={cn('lb-numeric text-xl font-bold', overdue > 0 && 'text-danger')}>{money(overdue)}</p></CardBody></Card>
      </div>

      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2"><Building2 className="h-5 w-5" aria-hidden="true" /> الحسابات</CardTitle>
          <Button size="sm" onClick={() => setForm({ name: '', phone: '', contact: '', limit: '', terms: '30' })} data-testid="new-account"><Plus className="h-4 w-4" aria-hidden="true" /> حساب جديد</Button>
        </CardHeader>
        <CardBody className="space-y-3">
          {form && (
            <form onSubmit={create} className="grid gap-3 rounded border border-line p-3 md:grid-cols-5" aria-label="حساب جديد">
              <Field label="اسم العميل / الشركة" required>{(p) => <Input {...p} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={160} required data-testid="acc-name" />}</Field>
              <Field label="الهاتف" required>{(p) => <Input {...p} dir="ltr" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} maxLength={30} required data-testid="acc-phone" />}</Field>
              <Field label="المسؤول">{(p) => <Input {...p} value={form.contact} onChange={(e) => setForm({ ...form, contact: e.target.value })} maxLength={120} />}</Field>
              <Field label="حد الائتمان" hint="0 = بدون حد مسموح">{(p) => <Input {...p} dir="ltr" inputMode="decimal" value={form.limit} onChange={(e) => setForm({ ...form, limit: e.target.value })} data-testid="acc-limit" />}</Field>
              <Field label="مهلة السداد (يوم)">{(p) => <Input {...p} type="number" min={0} max={365} dir="ltr" value={form.terms} onChange={(e) => setForm({ ...form, terms: e.target.value })} />}</Field>
              <div className="flex gap-2 md:col-span-5">
                <Button type="submit" size="sm" disabled={pending} data-testid="acc-save">فتح الحساب</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setForm(null)}>إلغاء</Button>
              </div>
            </form>
          )}
          {accounts.length === 0 ? <p className="text-sm text-muted">لا توجد حسابات آجلة بعد.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="accounts">
                <thead className="text-xs text-muted">
                  <tr><th className="p-2 text-start">العميل</th><th className="p-2 text-end">الرصيد</th><th className="p-2 text-end">الحد</th><th className="p-2 text-end">متأخر</th><th className="p-2 text-start">المهلة</th><th className="p-2" /></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {accounts.map((a) => {
                    const over = a.limitCents > 0 && a.balanceCents > a.limitCents;
                    return (
                      <tr key={a.customerId} className={cn(!a.isActive && 'opacity-60')}>
                        <td className="p-2"><p className="font-medium">{a.name}</p><p className="text-xs text-muted" dir="ltr">{a.phone}</p></td>
                        <td className={cn('lb-numeric p-2 font-bold', over && 'text-danger')}>{money(a.balanceCents)}</td>
                        <td className="lb-numeric p-2">{a.limitCents ? money(a.limitCents) : '—'}</td>
                        <td className="lb-numeric p-2">{a.overdueCents ? <Badge tone="danger">{money(a.overdueCents)}</Badge> : '—'}</td>
                        <td className="p-2">{a.termsDays} يوم</td>
                        <td className="p-2 text-end"><Link href={`${basePath}/${a.customerId}`} className="text-primary hover:underline">كشف الحساب</Link></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
