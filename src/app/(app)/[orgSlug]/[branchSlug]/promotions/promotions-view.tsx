'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Clock, Gift, Percent, Plus, Tag, Ticket } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Field, Input, Select } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { useApproval } from '@/components/patterns/approval-dialog';
import { formatMoney } from '@/lib/money';
import { fromCents, toCents } from '@/lib/amount-input';
import { cn } from '@/lib/cn';
import type { Promotion, PromotionKind, Reward } from '@/modules/restaurant/crm/service';
import { adjustPointsAction, redeemRewardAction, savePromotionAction, saveRewardAction } from './actions';

type Scope = { organizationSlug: string; branchSlug: string };
type Opt = { id: string; name: string };

const KIND: Record<PromotionKind, { label: string; icon: typeof Clock }> = {
  happy_hour: { label: 'الساعة السعيدة', icon: Clock },
  bogo: { label: 'اشترِ X واحصل على Y', icon: Gift },
  code: { label: 'كود خصم', icon: Ticket },
};
const DAYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

type PromoForm = {
  id: string | null; name: string; kind: PromotionKind; isActive: boolean; allBranches: boolean;
  startsAt: string; endsAt: string; daysOfWeek: number[]; startTime: string; endTime: string;
  percent: string; amount: string; productIds: string[]; categoryIds: string[];
  buyQty: string; getQty: string; getPercent: string; code: string; minOrder: string; maxUses: string;
};
const blank = (kind: PromotionKind): PromoForm => ({
  id: null, name: '', kind, isActive: true, allBranches: true, startsAt: '', endsAt: '', daysOfWeek: [],
  startTime: kind === 'happy_hour' ? '15:00' : '', endTime: kind === 'happy_hour' ? '18:00' : '',
  percent: kind === 'bogo' ? '' : '10', amount: '', productIds: [], categoryIds: [],
  buyQty: '1', getQty: '1', getPercent: '100', code: '', minOrder: '', maxUses: '',
});
const fromPromo = (p: Promotion): PromoForm => ({
  id: p.id, name: p.name, kind: p.kind, isActive: p.isActive, allBranches: p.branchId === null,
  startsAt: p.startsAt?.slice(0, 10) ?? '', endsAt: p.endsAt?.slice(0, 10) ?? '', daysOfWeek: p.daysOfWeek,
  startTime: p.startTime?.slice(0, 5) ?? '', endTime: p.endTime?.slice(0, 5) ?? '',
  percent: p.percentBp ? String(p.percentBp / 100) : '', amount: p.amountCents ? fromCents(p.amountCents) : '',
  productIds: p.productIds, categoryIds: p.categoryIds, buyQty: String(p.buyQty ?? 1), getQty: String(p.getQty ?? 1),
  getPercent: String((p.getPercentBp ?? 10000) / 100), code: p.code ?? '', minOrder: p.minOrderCents ? fromCents(p.minOrderCents) : '',
  maxUses: p.maxUses ? String(p.maxUses) : '',
});

export function PromotionsView({ scope, organizationId, currency, promotions, rewards, products, categories, variants, can }: {
  scope: Scope; organizationId: string; currency: string; promotions: Promotion[]; rewards: Reward[];
  products: (Opt & { categoryId: string | null })[]; categories: Opt[]; variants: Opt[];
  can: { promotions: boolean; loyalty: boolean; redeem: boolean };
}) {
  const money = (c: number) => formatMoney(c, currency);
  return (
    <div className="space-y-4">
      {can.promotions && <PromotionsPanel scope={scope} promotions={promotions} products={products} categories={categories} money={money} />}
      <div className="grid gap-4 lg:grid-cols-2">
        {can.loyalty && <RewardsPanel scope={scope} rewards={rewards} variants={variants} money={money} />}
        <div className="space-y-4">
          {can.redeem && <RedeemPanel scope={scope} rewards={rewards.filter((r) => r.isActive)} money={money} />}
          {can.loyalty && <AdjustPointsPanel scope={scope} organizationId={organizationId} />}
        </div>
      </div>
    </div>
  );
}

function PromotionsPanel({ scope, promotions, products, categories, money }: {
  scope: Scope; promotions: Promotion[]; products: (Opt & { categoryId: string | null })[]; categories: Opt[]; money: (c: number) => string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [form, setForm] = useState<PromoForm | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    const minOrder = toCents(form.minOrder || '0');
    const amount = form.amount ? toCents(form.amount) : null;
    if (minOrder === null || (form.amount && amount === null)) { toast.error('المبلغ غير صالح'); return; }
    start(async () => {
      const r = await savePromotionAction(scope, {
        id: form.id, name: form.name, kind: form.kind, isActive: form.isActive, allBranches: form.allBranches,
        startsAt: form.startsAt ? new Date(`${form.startsAt}T00:00:00`).toISOString() : null,
        endsAt: form.endsAt ? new Date(`${form.endsAt}T23:59:59`).toISOString() : null,
        daysOfWeek: form.daysOfWeek, startTime: form.startTime || null, endTime: form.endTime || null,
        percent: form.percent ? Number(form.percent) : null, amountCents: amount,
        productIds: form.productIds, categoryIds: form.categoryIds,
        buyQty: form.kind === 'bogo' ? Number(form.buyQty) : null, getQty: form.kind === 'bogo' ? Number(form.getQty) : null,
        getPercent: form.kind === 'bogo' ? Number(form.getPercent) : null,
        code: form.kind === 'code' ? form.code.trim().toUpperCase() : null, minOrderCents: minOrder,
        maxUses: form.maxUses ? Number(form.maxUses) : null,
      });
      if (!r.ok) { setErrors(r.fieldErrors ?? {}); toast.error(r.error); return; }
      toast.success('تم حفظ العرض'); setForm(null); setErrors({}); router.refresh();
    });
  }

  function toggle(p: Promotion) {
    start(async () => {
      const f = fromPromo(p);
      const r = await savePromotionAction(scope, {
        ...f, isActive: !p.isActive, startsAt: p.startsAt, endsAt: p.endsAt, startTime: f.startTime || null, endTime: f.endTime || null,
        percent: p.percentBp ? p.percentBp / 100 : null, amountCents: p.amountCents, buyQty: p.buyQty, getQty: p.getQty,
        getPercent: p.getPercentBp ? p.getPercentBp / 100 : null, code: p.code, minOrderCents: p.minOrderCents, maxUses: p.maxUses,
      });
      if (!r.ok) { toast.error(r.error); return; }
      router.refresh();
    });
  }

  const describe = (p: Promotion) => {
    const scopeText = p.productIds.length || p.categoryIds.length ? ` على ${p.productIds.length + p.categoryIds.length} صنف/قسم` : ' على كل المنيو';
    if (p.kind === 'happy_hour') return `خصم ${(p.percentBp ?? 0) / 100}% من ${p.startTime?.slice(0, 5)} إلى ${p.endTime?.slice(0, 5)}${scopeText}`;
    if (p.kind === 'bogo') return `اشترِ ${p.buyQty} واحصل على ${p.getQty} ${p.getPercentBp === 10000 ? 'مجانًا' : `بخصم ${(p.getPercentBp ?? 0) / 100}%`}${scopeText}`;
    return `الكود ${p.code}: ${p.percentBp ? `${p.percentBp / 100}%` : money(p.amountCents ?? 0)}${p.minOrderCents ? ` لطلب من ${money(p.minOrderCents)}` : ''}`;
  };

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2"><Tag className="h-5 w-5" aria-hidden="true" /> العروض</CardTitle>
        <div className="flex flex-wrap gap-1">
          {(Object.keys(KIND) as PromotionKind[]).map((k) => (
            <Button key={k} size="sm" variant="secondary" onClick={() => { setForm(blank(k)); setErrors({}); }} data-testid={`new-${k}`}>
              <Plus className="h-4 w-4" aria-hidden="true" /> {KIND[k].label}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        {form && (
          <form onSubmit={save} className="space-y-3 rounded border border-line p-3" aria-label="العرض">
            <p className="text-sm font-bold">{KIND[form.kind].label}</p>
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="اسم العرض" required error={errors.name}>{(p) => <Input {...p} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={120} required data-testid="promo-name" />}</Field>
              {form.kind === 'code' && <Field label="الكود" required error={errors.code}>{(p) => <Input {...p} dir="ltr" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} maxLength={32} placeholder="SUMMER25" data-testid="promo-code" />}</Field>}
              {form.kind !== 'bogo' && <Field label="نسبة الخصم %" error={errors.percent}>{(p) => <Input {...p} dir="ltr" inputMode="decimal" value={form.percent} onChange={(e) => setForm({ ...form, percent: e.target.value })} data-testid="promo-percent" />}</Field>}
              {form.kind === 'code' && <Field label="أو مبلغ ثابت" hint="اترك النسبة فارغة لاستخدام المبلغ">{(p) => <Input {...p} dir="ltr" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />}</Field>}
              {form.kind === 'bogo' && (
                <>
                  <Field label="اشترِ (عدد)" error={errors.buyQty}>{(p) => <Input {...p} type="number" min={1} max={50} dir="ltr" value={form.buyQty} onChange={(e) => setForm({ ...form, buyQty: e.target.value })} />}</Field>
                  <Field label="واحصل على (عدد)">{(p) => <Input {...p} type="number" min={1} max={50} dir="ltr" value={form.getQty} onChange={(e) => setForm({ ...form, getQty: e.target.value })} />}</Field>
                  <Field label="خصم المجاني %" hint="100 = مجانًا">{(p) => <Input {...p} dir="ltr" inputMode="decimal" value={form.getPercent} onChange={(e) => setForm({ ...form, getPercent: e.target.value })} />}</Field>
                </>
              )}
              {form.kind === 'happy_hour' && (
                <>
                  <Field label="من الساعة">{(p) => <Input {...p} type="time" dir="ltr" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} />}</Field>
                  <Field label="إلى الساعة">{(p) => <Input {...p} type="time" dir="ltr" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} />}</Field>
                </>
              )}
              {form.kind === 'code' && (
                <>
                  <Field label="حد أدنى للطلب">{(p) => <Input {...p} dir="ltr" inputMode="decimal" value={form.minOrder} onChange={(e) => setForm({ ...form, minOrder: e.target.value })} />}</Field>
                  <Field label="أقصى عدد استخدامات">{(p) => <Input {...p} type="number" min={1} dir="ltr" value={form.maxUses} onChange={(e) => setForm({ ...form, maxUses: e.target.value })} />}</Field>
                </>
              )}
              <Field label="يبدأ في">{(p) => <Input {...p} type="date" dir="ltr" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} />}</Field>
              <Field label="ينتهي في">{(p) => <Input {...p} type="date" dir="ltr" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} />}</Field>
            </div>

            <div>
              <p className="mb-1 text-xs text-muted">أيام العرض (لا شيء = كل الأيام)</p>
              <div className="flex flex-wrap gap-1">
                {DAYS.map((d, i) => (
                  <button key={d} type="button" onClick={() => setForm({ ...form, daysOfWeek: form.daysOfWeek.includes(i) ? form.daysOfWeek.filter((x) => x !== i) : [...form.daysOfWeek, i].sort() })}
                    className={cn('rounded border px-2 py-1 text-xs', form.daysOfWeek.includes(i) ? 'border-primary bg-primary-soft text-primary' : 'border-line')}>{d}</button>
                ))}
              </div>
            </div>

            {form.kind !== 'code' && (
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="الأقسام المشمولة" hint="لا شيء = كل المنيو (Ctrl لاختيار أكثر من قسم)">{(p) => (
                  <Select {...p} multiple className="h-28" value={form.categoryIds} onChange={(e) => setForm({ ...form, categoryIds: Array.from(e.target.selectedOptions).map((o) => o.value) })}>
                    {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                )}</Field>
                <Field label="أصناف محددة">{(p) => (
                  <Select {...p} multiple className="h-28" value={form.productIds} onChange={(e) => setForm({ ...form, productIds: Array.from(e.target.selectedOptions).map((o) => o.value) })}>
                    {products.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                )}</Field>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-4 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} /> فعّال</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={form.allBranches} onChange={(e) => setForm({ ...form, allBranches: e.target.checked })} /> كل الفروع</label>
            </div>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={pending} data-testid="promo-save">حفظ</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setForm(null)}>إلغاء</Button>
            </div>
          </form>
        )}

        {promotions.length === 0 ? <p className="text-sm text-muted">لا توجد عروض بعد.</p> : (
          <ul className="divide-y divide-line" data-testid="promotions">
            {promotions.map((p) => {
              const Icon = KIND[p.kind].icon;
              return (
                <li key={p.id} className={cn('flex flex-wrap items-center justify-between gap-2 py-2 text-sm', !p.isActive && 'opacity-60')}>
                  <div className="flex items-start gap-2">
                    <Icon className="mt-0.5 h-4 w-4 text-primary" aria-hidden="true" />
                    <div>
                      <p className="font-medium">{p.name} <Badge tone="neutral">{KIND[p.kind].label}</Badge></p>
                      <p className="text-xs text-muted">{describe(p)}{p.daysOfWeek.length ? ` · ${p.daysOfWeek.map((d) => DAYS[d]).join('، ')}` : ''}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted">استُخدم <span className="lb-numeric">{p.uses}</span>{p.maxUses ? ` / ${p.maxUses}` : ''}</span>
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => toggle(p)}>{p.isActive ? 'إيقاف' : 'تفعيل'}</Button>
                    <Button size="sm" variant="ghost" onClick={() => { setForm(fromPromo(p)); setErrors({}); }}>تعديل</Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function RewardsPanel({ scope, rewards, variants, money }: { scope: Scope; rewards: Reward[]; variants: Opt[]; money: (c: number) => string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [form, setForm] = useState<{ id: string | null; name: string; points: string; kind: Reward['kind']; value: string; variantId: string; isActive: boolean } | null>(null);

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    const value = form.value ? toCents(form.value) : null;
    if (form.kind === 'discount' && !value) { toast.error('حدد قيمة الخصم'); return; }
    if (form.kind === 'free_item' && !form.variantId) { toast.error('اختر الصنف المجاني'); return; }
    start(async () => {
      const r = await saveRewardAction(scope, { id: form.id, name: form.name, pointsCost: Number(form.points), kind: form.kind, valueCents: value, variantId: form.kind === 'free_item' ? form.variantId : null, isActive: form.isActive });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success('تم حفظ المكافأة'); setForm(null); router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle className="flex items-center gap-2"><Gift className="h-5 w-5" aria-hidden="true" /> مكافآت النقاط</CardTitle>
        <Button size="sm" onClick={() => setForm({ id: null, name: '', points: '100', kind: 'discount', value: '', variantId: '', isActive: true })} data-testid="new-reward"><Plus className="h-4 w-4" aria-hidden="true" /> مكافأة</Button>
      </CardHeader>
      <CardBody className="space-y-3">
        {form && (
          <form onSubmit={save} className="space-y-2 rounded border border-line p-3" aria-label="المكافأة">
            <Input aria-label="اسم المكافأة" placeholder="اسم المكافأة" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={80} />
            <div className="flex gap-2">
              <Input aria-label="النقاط المطلوبة" type="number" min={1} dir="ltr" value={form.points} onChange={(e) => setForm({ ...form, points: e.target.value })} />
              <Select aria-label="نوع المكافأة" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Reward['kind'] })}>
                <option value="discount">خصم بمبلغ</option>
                <option value="free_item">صنف مجاني</option>
              </Select>
            </div>
            {form.kind === 'discount' ? (
              <Input aria-label="قيمة الخصم" placeholder="قيمة الخصم" dir="ltr" inputMode="decimal" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
            ) : (
              <Select aria-label="الصنف المجاني" value={form.variantId} onChange={(e) => setForm({ ...form, variantId: e.target.value })}>
                <option value="">— الصنف —</option>
                {variants.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </Select>
            )}
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} /> متاحة</label>
            <div className="flex gap-2"><Button type="submit" size="sm" disabled={pending}>حفظ</Button><Button type="button" size="sm" variant="ghost" onClick={() => setForm(null)}>إلغاء</Button></div>
          </form>
        )}
        {rewards.length === 0 ? <p className="text-sm text-muted">لا توجد مكافآت. يكسب العملاء النقاط تلقائيًا مع كل طلب مكتمل.</p> : (
          <ul className="divide-y divide-line text-sm">
            {rewards.map((r) => (
              <li key={r.id} className={cn('flex items-center justify-between py-2', !r.isActive && 'opacity-60')}>
                <span>{r.name} <span className="text-xs text-muted">— {r.kind === 'discount' ? `خصم ${money(r.valueCents ?? 0)}` : 'صنف مجاني'}</span></span>
                <span className="flex items-center gap-2">
                  <Badge tone="info"><span className="lb-numeric">{r.pointsCost}</span> نقطة</Badge>
                  <Button size="sm" variant="ghost" onClick={() => setForm({ id: r.id, name: r.name, points: String(r.pointsCost), kind: r.kind, value: r.valueCents ? fromCents(r.valueCents) : '', variantId: r.variantId ?? '', isActive: r.isActive })}>تعديل</Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function RedeemPanel({ scope, rewards, money }: { scope: Scope; rewards: Reward[]; money: (c: number) => string }) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const [phone, setPhone] = useState('');
  const [rewardId, setRewardId] = useState('');
  const [result, setResult] = useState<{ code: string; valueCents: number; reward: string; balance: number } | null>(null);

  function redeem(e: React.FormEvent) {
    e.preventDefault();
    start(async () => {
      const r = await redeemRewardAction(scope, { phone, rewardId });
      if (!r.ok) { toast.error(r.error); return; }
      setResult(r.data);
    });
  }

  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Ticket className="h-5 w-5" aria-hidden="true" /> استبدال نقاط لضيف</CardTitle></CardHeader>
      <CardBody className="space-y-2">
        <form onSubmit={redeem} className="space-y-2">
          <Input aria-label="هاتف الضيف" placeholder="هاتف الضيف" dir="ltr" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={30} />
          <Select aria-label="المكافأة" value={rewardId} onChange={(e) => setRewardId(e.target.value)}>
            <option value="">— المكافأة —</option>
            {rewards.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.pointsCost} نقطة)</option>)}
          </Select>
          <Button type="submit" size="sm" disabled={pending || phone.trim().length < 7 || !rewardId}>استبدال</Button>
        </form>
        {result && (
          <div className="rounded border border-green-300 bg-green-50 p-2 text-sm">
            <p>{result.reward}: الكود <strong dir="ltr" className="font-mono">{result.code}</strong> بقيمة <span className="lb-numeric">{money(result.valueCents)}</span></p>
            <p className="text-xs text-muted">أدخله في خانة الكوبون عند الدفع. الرصيد المتبقي: {result.balance} نقطة.</p>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function AdjustPointsPanel({ scope, organizationId }: { scope: Scope; organizationId: string }) {
  const toast = useToast();
  const approval = useApproval(scope);
  const [pending, start] = useTransition();
  const [phone, setPhone] = useState('');
  const [points, setPoints] = useState('');
  const [note, setNote] = useState('');

  async function run(): Promise<void> {
    const n = Number(points);
    const r = await adjustPointsAction(scope, { phone, points: n, note });
    if (!r.ok) {
      if (r.code === 'approval_required') { approval.request('loyalty.adjust', organizationId, Math.abs(n), run); return; }
      toast.error(r.error); return;
    }
    toast.success(`تم التعديل — الرصيد الآن ${r.data.balance} نقطة`);
    setPoints(''); setNote('');
  }

  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Percent className="h-5 w-5" aria-hidden="true" /> تعديل نقاط يدوي</CardTitle></CardHeader>
      <CardBody>
        <form onSubmit={(e) => { e.preventDefault(); start(run); }} className="space-y-2">
          <Input aria-label="هاتف العميل" placeholder="هاتف العميل" dir="ltr" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={30} />
          <Input aria-label="النقاط" placeholder="+50 أو -20" dir="ltr" inputMode="numeric" value={points} onChange={(e) => setPoints(e.target.value)} />
          <Input aria-label="السبب" placeholder="السبب (مطلوب)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
          <p className="text-xs text-muted">يحتاج موافقة المدير برمز PIN ويُسجّل في سجل النشاط.</p>
          <Button type="submit" size="sm" disabled={pending || !phone || !points || !note.trim() || !Number.isInteger(Number(points)) || Number(points) === 0}>تعديل</Button>
        </form>
      </CardBody>
      {approval.dialog}
    </Card>
  );
}
