'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Trash } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/cn';
import type { WastageEntry, WastageSummary } from '@/modules/restaurant/wastage/service';
import {
  INPUT_UNITS, LOCATION_LABELS, WASTE_REASONS, WASTE_REASON_LABELS, formatQty, toBase, type BaseUnit, type InputUnit,
} from '@/modules/restaurant/inventory/units';
import { recordWasteAction } from '../../stock/actions';

type Scope = { organizationSlug: string; branchSlug: string };
type Item = { id: string; name: string; unit: BaseUnit; avgCostCents: number };
const when = (iso: string) => new Date(iso).toLocaleString('ar-EG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Log a loss in one line, then see where the money goes: by reason, by item, every entry. */
export function WastageBoard({ scope, basePath, currency, days, entries, summary, items, canRecord }: {
  scope: Scope; basePath: string; currency: string; days: number; entries: WastageEntry[]; summary: WastageSummary; items: Item[]; canRecord: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const money = (c: number) => formatMoney(Math.round(c), currency);
  const [form, setForm] = useState({ kind: 'kitchen' as 'warehouse' | 'kitchen' | 'bar', itemId: '', amount: '', unit: 'g' as InputUnit, reason: 'spoiled', note: '' });
  const item = items.find((i) => i.id === form.itemId);
  const qty = item && Number(form.amount) > 0 ? toBase(Number(form.amount), item.unit, form.unit) : 0;
  const maxReason = Math.max(...summary.byReason.map((r) => r.costCents), 1);

  function record(e: React.FormEvent) {
    e.preventDefault();
    if (!item || !(qty > 0)) { toast.error('اختر الخامة والكمية'); return; }
    if (form.reason === 'other' && !form.note.trim()) { toast.error('اكتب السبب'); return; }
    start(async () => {
      const r = await recordWasteAction(scope, { kind: form.kind, itemId: item.id, qty, reason: form.reason as never, note: form.note.trim() || undefined });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success(`سُجّل هالك ${formatQty(qty, item.unit)} ${item.name}`);
      setForm({ ...form, amount: '', note: '' });
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {canRecord && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Trash className="h-5 w-5" aria-hidden="true" /> تسجيل هالك</CardTitle></CardHeader>
          <CardBody>
            <form onSubmit={record} className="grid gap-3 md:grid-cols-6" aria-label="تسجيل هالك">
              <Field label="المكان">{(p) => (
                <Select {...p} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as typeof form.kind })}>
                  {(['kitchen', 'bar', 'warehouse'] as const).map((k) => <option key={k} value={k}>{LOCATION_LABELS[k]}</option>)}
                </Select>
              )}</Field>
              <div className="md:col-span-2">
                <Field label="الخامة" required>{(p) => (
                  <Select {...p} value={form.itemId} onChange={(e) => setForm({ ...form, itemId: e.target.value, unit: items.find((i) => i.id === e.target.value)?.unit ?? 'g' })} data-testid="waste-item">
                    <option value="">— الخامة —</option>
                    {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                  </Select>
                )}</Field>
              </div>
              <Field label="الكمية" required>{(p) => (
                <div className="flex gap-1">
                  <Input {...p} dir="ltr" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} data-testid="waste-qty" />
                  <Select aria-label="الوحدة" value={form.unit} disabled={!item} onChange={(e) => setForm({ ...form, unit: e.target.value as InputUnit })} className="w-24">
                    {(item ? INPUT_UNITS[item.unit] : INPUT_UNITS.g).map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
                  </Select>
                </div>
              )}</Field>
              <Field label="السبب">{(p) => (
                <Select {...p} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} data-testid="waste-reason">
                  {WASTE_REASONS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                </Select>
              )}</Field>
              <Field label="ملاحظة" required={form.reason === 'other'}>{(p) => (
                <Input {...p} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={300} placeholder="مثال: احترقت في الفرن" />
              )}</Field>
              <div className="flex items-end justify-between gap-2 md:col-span-6">
                <p className="text-sm text-muted">{item && qty > 0 ? <>التكلفة التقديرية: <span className="lb-numeric font-medium text-fg">{money(qty * item.avgCostCents)}</span></> : ' '}</p>
                <Button type="submit" disabled={pending || !item || !(qty > 0)} data-testid="waste-submit">تسجيل</Button>
              </div>
            </form>
          </CardBody>
        </Card>
      )}

      <div className="flex flex-wrap gap-1" role="group" aria-label="الفترة">
        {[1, 7, 30, 90].map((d) => (
          <Link key={d} href={`${basePath}?days=${d}`} className={cn('rounded border px-3 py-1.5 text-sm', d === days ? 'border-primary bg-primary-soft text-primary' : 'border-line')}>
            {d === 1 ? 'اليوم' : `آخر ${d} يوم`}
          </Link>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>تكلفة الهالك</CardTitle></CardHeader>
          <CardBody className="space-y-3">
            <p className="lb-numeric text-3xl font-bold" data-testid="waste-total">{money(summary.totalCents)}</p>
            <p className="text-xs text-muted">{entries.length} تسجيل في الفترة</p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader><CardTitle>حسب السبب</CardTitle></CardHeader>
          <CardBody>
            {summary.byReason.length === 0 ? <p className="text-sm text-muted">لا هالك.</p> : (
              <ul className="space-y-2 text-sm">
                {summary.byReason.map((r) => (
                  <li key={r.reason}>
                    <div className="flex justify-between"><span>{WASTE_REASON_LABELS[r.reason] ?? r.reason} <span className="text-xs text-muted">({r.count})</span></span><span className="lb-numeric">{money(r.costCents)}</span></div>
                    <div className="mt-1 h-1.5 rounded-full bg-line"><div className="h-full rounded-full bg-primary" style={{ width: `${(r.costCents / maxReason) * 100}%` }} /></div>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader><CardTitle>أكثر الخامات هالكًا</CardTitle></CardHeader>
          <CardBody>
            {summary.topItems.length === 0 ? <p className="text-sm text-muted">لا هالك.</p> : (
              <ol className="space-y-1 text-sm">
                {summary.topItems.map((i) => (
                  <li key={i.itemId} className="flex justify-between gap-2"><span>{i.name} <span className="text-xs text-muted">{formatQty(i.qty, i.unit)}</span></span><span className="lb-numeric">{money(i.costCents)}</span></li>
                ))}
              </ol>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>السجل</CardTitle></CardHeader>
        <CardBody className="p-0">
          {entries.length === 0 ? <p className="p-5 text-center text-sm text-muted">لا تسجيلات في هذه الفترة.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="waste-log">
                <thead className="border-b border-line text-xs text-muted">
                  <tr><th className="p-2 text-start">الوقت</th><th className="p-2 text-start">الخامة</th><th className="p-2 text-start">المكان</th><th className="p-2 text-start">الكمية</th><th className="p-2 text-start">السبب</th><th className="p-2 text-end">التكلفة</th><th className="p-2 text-start">بواسطة</th></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {entries.map((e) => (
                    <tr key={e.id}>
                      <td className="whitespace-nowrap p-2 text-xs">{when(e.createdAt)}</td>
                      <td className="p-2">{e.itemName}</td>
                      <td className="p-2">{LOCATION_LABELS[e.location] ?? e.location}</td>
                      <td className="lb-numeric p-2">{formatQty(e.qty, e.unit)}</td>
                      <td className="p-2">{WASTE_REASON_LABELS[e.reason] ?? e.reason}{e.note && <span className="block text-xs text-muted">{e.note}</span>}</td>
                      <td className="lb-numeric p-2 text-end">{money(e.costCents)}</td>
                      <td className="p-2 text-xs text-muted">{e.recordedBy ?? (e.orderId ? 'إلغاء طلب' : '—')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
