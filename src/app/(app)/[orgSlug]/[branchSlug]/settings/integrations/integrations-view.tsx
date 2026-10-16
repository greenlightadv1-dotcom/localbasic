'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Copy, KeyRound, Plug, Plus } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { Field, Input } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import type { Integration } from '@/modules/restaurant/integrations/service';
import { createIntegrationAction, setIntegrationAction } from './actions';

type Scope = { organizationSlug: string; branchSlug: string };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }) : 'لم يُستخدم بعد');

const SAMPLE = `{
  "external_id": "ORD-10045",
  "type": "delivery",
  "customer": { "name": "أحمد", "phone": "01012345678" },
  "delivery": { "address": "12 ش التحرير، الدور 3", "area": "الدقي", "landmark": "بجوار البنك" },
  "items": [
    { "variant_id": "<variant uuid من /menu>", "quantity": 2, "modifier_ids": [], "note": "بدون بصل" }
  ],
  "note": "اتصل قبل الوصول",
  "paid": true,
  "total_cents": 25000
}`;

export function IntegrationsView({ scope, appUrl, integrations }: { scope: Scope; appUrl: string; integrations: Integration[] }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [form, setForm] = useState<{ name: string; source: string; autoConfirm: boolean } | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);

  function create(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    start(async () => {
      const r = await createIntegrationAction(scope, form);
      if (!r.ok) { toast.error(r.error); return; }
      setNewKey(r.data.key); setForm(null); router.refresh();
    });
  }

  function set(i: Integration, patch: { isActive?: boolean; autoConfirm?: boolean }) {
    start(async () => {
      const r = await setIntegrationAction(scope, { id: i.id, ...patch });
      if (!r.ok) { toast.error(r.error); return; }
      router.refresh();
    });
  }

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); toast.success('تم النسخ'); } catch { toast.error('تعذّر النسخ'); }
  }

  return (
    <div className="space-y-4">
      {newKey && (
        <Alert tone="warn">
          <div className="space-y-2" data-testid="new-key">
            <p className="font-bold">انسخ المفتاح الآن — لن يظهر مرة أخرى.</p>
            <div className="flex items-center gap-2">
              <code dir="ltr" className="flex-1 break-all rounded bg-surface p-2 text-xs">{newKey}</code>
              <Button size="sm" variant="secondary" onClick={() => copy(newKey)}><Copy className="h-4 w-4" aria-hidden="true" /> نسخ</Button>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setNewKey(null)}>تم الحفظ</Button>
          </div>
        </Alert>
      )}

      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2"><Plug className="h-5 w-5" aria-hidden="true" /> مصادر الطلبات</CardTitle>
          <Button size="sm" onClick={() => setForm({ name: '', source: '', autoConfirm: true })} data-testid="new-integration"><Plus className="h-4 w-4" aria-hidden="true" /> مفتاح جديد</Button>
        </CardHeader>
        <CardBody className="space-y-3">
          {form && (
            <form onSubmit={create} className="grid gap-3 rounded border border-line p-3 md:grid-cols-3" aria-label="تكامل جديد">
              <Field label="الاسم" required>{(p) => <Input {...p} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="طلبات / تطبيقنا" maxLength={80} required data-testid="int-name" />}</Field>
              <Field label="المصدر" hint="حروف إنجليزية صغيرة: talabat, website, app" required>{(p) => <Input {...p} dir="ltr" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value.toLowerCase() })} maxLength={40} required data-testid="int-source" />}</Field>
              <label className="flex items-center gap-2 self-end text-sm"><input type="checkbox" checked={form.autoConfirm} onChange={(e) => setForm({ ...form, autoConfirm: e.target.checked })} /> إرسال للمطبخ مباشرة (بدون مراجعة الكاشير)</label>
              <div className="flex gap-2 md:col-span-3">
                <Button type="submit" size="sm" disabled={pending} data-testid="int-create"><KeyRound className="h-4 w-4" aria-hidden="true" /> إنشاء المفتاح</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setForm(null)}>إلغاء</Button>
              </div>
            </form>
          )}
          {integrations.length === 0 ? <p className="text-sm text-muted">لا توجد مفاتيح بعد.</p> : (
            <ul className="divide-y divide-line" data-testid="integrations">
              {integrations.map((i) => (
                <li key={i.id} className={cn('flex flex-wrap items-center justify-between gap-2 py-2 text-sm', !i.isActive && 'opacity-60')}>
                  <div>
                    <p className="font-medium">{i.name} <Badge tone="neutral">{i.source}</Badge> {!i.isActive && <Badge tone="danger">موقوف</Badge>}</p>
                    <p className="text-xs text-muted"><code dir="ltr">{i.keyPrefix}…</code> · آخر استخدام: {when(i.lastUsedAt)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={i.autoConfirm} disabled={pending} onChange={(e) => set(i, { autoConfirm: e.target.checked })} /> للمطبخ مباشرة</label>
                    <Button size="sm" variant={i.isActive ? 'ghost' : 'secondary'} disabled={pending} onClick={() => set(i, { isActive: !i.isActive })}>{i.isActive ? 'إيقاف المفتاح' : 'تفعيل'}</Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>طريقة الربط</CardTitle></CardHeader>
        <CardBody className="space-y-3 text-sm">
          <p>كل الطلبات ترسل بالمفتاح في الترويسة <code dir="ltr">Authorization: Bearer lbk_…</code>. الأسعار تُحسب من منيو الفرع وليس من الطلب المرسل؛ <code dir="ltr">total_cents</code> يُحفظ للمطابقة فقط. إرسال نفس <code dir="ltr">external_id</code> مرتين يعيد نفس الطلب ولا يكرّره.</p>
          <div className="space-y-1">
            <p className="font-medium">1. المنيو (المعرّفات والأسعار)</p>
            <code dir="ltr" className="block rounded bg-surface p-2 text-xs">GET {appUrl}/api/integrations/menu</code>
          </div>
          <div className="space-y-1">
            <p className="font-medium">2. إرسال طلب</p>
            <code dir="ltr" className="block rounded bg-surface p-2 text-xs">POST {appUrl}/api/integrations/orders</code>
            <pre dir="ltr" className="overflow-x-auto rounded bg-surface p-2 text-xs">{SAMPLE}</pre>
          </div>
          <p className="text-xs text-muted">الرد: <code dir="ltr">{'{ order_id, number, status, total_cents, duplicate }'}</code>. الأخطاء: 401 مفتاح غير صالح، 422 بيانات غير صحيحة (صنف غير متاح…)، 429 تجاوز الحد.</p>
        </CardBody>
      </Card>
    </div>
  );
}
