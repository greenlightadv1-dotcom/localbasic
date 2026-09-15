'use client';

import { useId, useState } from 'react';
import { cn } from '@/lib/cn';

/**
 * Marketing product preview.
 *
 * Every value below is hard-coded presentation data written for this page. It
 * never reads the database, never calls a service, and is rendered to anonymous
 * visitors — so no tenant data can reach it by construction.
 */

type RoleKey = 'owner' | 'cashier' | 'kitchen' | 'waiter' | 'customer';

const ROLES: { key: RoleKey; label: string; blurb: string }[] = [
  { key: 'owner', label: 'المالك', blurb: 'الأرقام والفروع والصلاحيات.' },
  { key: 'cashier', label: 'الكاشير', blurb: 'تسجيل الطلب والتحصيل.' },
  { key: 'kitchen', label: 'المطبخ', blurb: 'الطلبات وحالتها فقط.' },
  { key: 'waiter', label: 'الكابتن', blurb: 'الصالة والتقديم.' },
  { key: 'customer', label: 'العميل', blurb: 'المنيو والطلب من الجوال.' },
];

/** Chrome that frames each preview so it reads as a screen, not a card. */
function Screen({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-elevated shadow-card">
      <div className="flex items-center gap-2 border-b border-line bg-surface px-4 py-2.5">
        <span className="flex gap-1.5" aria-hidden>
          <span className="h-2.5 w-2.5 rounded-full bg-danger/40" />
          <span className="h-2.5 w-2.5 rounded-full bg-warn/40" />
          <span className="h-2.5 w-2.5 rounded-full bg-success/40" />
        </span>
        <p className="text-xs font-semibold text-muted">{title}</p>
      </div>
      <div className="p-4 sm:p-5">{children}</div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded border border-line bg-surface p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-lg font-extrabold text-fg">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-success">{hint}</p> : null}
    </div>
  );
}

function Pill({ tone, children }: { tone: 'new' | 'prep' | 'ready' | 'paid'; children: React.ReactNode }) {
  const tones = {
    new: 'bg-primary-soft text-primary',
    prep: 'bg-warn/15 text-warn',
    ready: 'bg-success/15 text-success',
    paid: 'bg-success/15 text-success',
  } as const;
  return (
    <span className={cn('rounded px-2 py-0.5 text-xs font-semibold', tones[tone])}>{children}</span>
  );
}

function OwnerPreview() {
  return (
    <Screen title="لوحة المالك — فرع المعادي">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="مبيعات اليوم" value="١٨٬٤٢٠ ج.م" hint="+١٢٪ عن أمس" />
        <Stat label="عدد الطلبات" value="١٤٢" />
        <Stat label="متوسط الطلب" value="١٢٩ ج.م" />
        <Stat label="رصيد الخزينة" value="٦٬٧٥٠ ج.م" />
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded border border-line p-3">
          <p className="mb-2 text-xs font-bold text-fg">الأكثر مبيعًا</p>
          <ul className="space-y-2 text-sm">
            {[['شاورما لحم', '٣٨'], ['فراخ مشوية', '٢٧'], ['عصير مانجو', '٢٤']].map(([n, c]) => (
              <li key={n} className="flex items-center justify-between">
                <span className="text-fg">{n}</span>
                <span className="text-muted">{c} طلب</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded border border-line p-3">
          <p className="mb-2 text-xs font-bold text-fg">الفروع</p>
          <ul className="space-y-2 text-sm">
            {[['المعادي', '١٨٬٤٢٠'], ['مدينة نصر', '١١٬٢٠٠']].map(([n, v]) => (
              <li key={n} className="flex items-center justify-between">
                <span className="text-fg">{n}</span>
                <span className="font-semibold text-fg">{v} ج.م</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Screen>
  );
}

function CashierPreview() {
  return (
    <Screen title="نقطة البيع — كاشير">
      <div className="grid gap-4 md:grid-cols-[1.3fr_1fr]">
        <div>
          <div className="mb-3 flex gap-2 overflow-x-auto">
            {['الكل', 'مشويات', 'مشروبات', 'حلويات'].map((c, i) => (
              <span
                key={c}
                className={cn(
                  'whitespace-nowrap rounded px-3 py-1.5 text-xs font-semibold',
                  i === 0 ? 'bg-primary text-primary-fg' : 'bg-surface text-muted',
                )}
              >
                {c}
              </span>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {[
              ['شاورما لحم', '٨٥'], ['فراخ مشوية', '١٢٠'], ['كفتة', '٩٥'],
              ['عصير مانجو', '٣٥'], ['مياه', '١٠'], ['أم علي', '٤٥'],
            ].map(([n, p]) => (
              <div key={n} className="rounded border border-line bg-surface p-3 text-center">
                <p className="text-sm font-semibold text-fg">{n}</p>
                <p className="mt-1 text-xs text-muted">{p} ج.م</p>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded border border-line p-3">
          <p className="mb-2 text-xs font-bold text-fg">طلب #١٠٤٢ — طاولة ٧</p>
          <ul className="space-y-2 border-b border-line pb-3 text-sm">
            {[['شاورما لحم ×٢', '١٧٠'], ['عصير مانجو ×١', '٣٥'], ['مياه ×٢', '٢٠']].map(([n, v]) => (
              <li key={n} className="flex items-center justify-between">
                <span className="text-fg">{n}</span>
                <span className="text-muted">{v}</span>
              </li>
            ))}
          </ul>
          <div className="space-y-1.5 pt-3 text-sm">
            <div className="flex justify-between text-muted"><span>الإجمالي الفرعي</span><span>٢٢٥</span></div>
            <div className="flex justify-between text-muted"><span>الخصم</span><span>٠</span></div>
            <div className="flex justify-between text-base font-extrabold text-fg">
              <span>الإجمالي</span><span>٢٢٥ ج.م</span>
            </div>
          </div>
          <div className="mt-3 rounded bg-primary px-4 py-3 text-center text-sm font-bold text-primary-fg">
            تحصيل نقدي
          </div>
          <p className="mt-2 text-center text-[11px] text-muted">
            الإجماليات تُحسب على الخادم دائمًا
          </p>
        </div>
      </div>
    </Screen>
  );
}

function KitchenPreview() {
  return (
    <Screen title="شاشة المطبخ">
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { n: '#١٠٤٢', t: 'طاولة ٧', s: 'new' as const, sl: 'جديد', m: '٢ دقيقة', items: ['شاورما لحم ×٢', 'عصير مانجو ×١'] },
          { n: '#١٠٤١', t: 'سفري', s: 'prep' as const, sl: 'تحضير', m: '٦ دقائق', items: ['فراخ مشوية ×١', 'أرز ×٢'] },
          { n: '#١٠٤٠', t: 'طاولة ٣', s: 'ready' as const, sl: 'جاهز', m: '١١ دقيقة', items: ['كفتة ×٣'] },
        ].map((o) => (
          <div key={o.n} className="rounded border border-line bg-surface p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-bold text-fg">{o.n}</span>
              <Pill tone={o.s}>{o.sl}</Pill>
            </div>
            <p className="mb-2 text-xs text-muted">{o.t} · {o.m}</p>
            <ul className="space-y-1 text-sm text-fg">
              {o.items.map((i) => <li key={i}>{i}</li>)}
            </ul>
          </div>
        ))}
      </div>
      <p className="mt-3 text-center text-[11px] text-muted">
        شاشة المطبخ لا تعرض أي مبالغ أو تقارير — لا صلاحية مالية لها إطلاقًا
      </p>
    </Screen>
  );
}

function WaiterPreview() {
  return (
    <Screen title="الصالة — كابتن">
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
        {[
          ['١', 'متاحة'], ['٢', 'مشغولة'], ['٣', 'جاهز'], ['٤', 'متاحة'], ['٥', 'مشغولة'],
          ['٦', 'متاحة'], ['٧', 'مشغولة'], ['٨', 'متاحة'], ['٩', 'محجوزة'], ['١٠', 'متاحة'],
        ].map(([n, s]) => (
          <div
            key={n}
            className={cn(
              'rounded border p-3 text-center',
              s === 'متاحة' && 'border-line bg-surface',
              s === 'مشغولة' && 'border-warn/30 bg-warn/10',
              s === 'جاهز' && 'border-success/30 bg-success/10',
              s === 'محجوزة' && 'border-primary/30 bg-primary-soft',
            )}
          >
            <p className="text-base font-extrabold text-fg">{n}</p>
            <p className="mt-0.5 text-[11px] text-muted">{s}</p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-center text-[11px] text-muted">
        الكابتن يفتح الطلب ويقدّمه — دون صلاحية تحصيل أو خصم
      </p>
    </Screen>
  );
}

function CustomerPreview() {
  return (
    <Screen title="منيو الضيف — من الجوال">
      <div className="mx-auto max-w-sm">
        <div className="rounded border border-line bg-surface p-3">
          <p className="text-xs text-muted">مطعم الحارة الشامية · طاولة ٧</p>
          <p className="mt-0.5 text-sm font-bold text-fg">المنيو</p>
        </div>
        <ul className="mt-3 space-y-2">
          {[['شاورما لحم', '٨٥', 'خبز شامي، طحينة، مخلل'], ['فراخ مشوية', '١٢٠', 'نصف فرخة مع أرز'], ['عصير مانجو', '٣٥', 'طازج']].map(
            ([n, p, d]) => (
              <li key={n} className="flex items-start justify-between gap-3 rounded border border-line p-3">
                <div>
                  <p className="text-sm font-semibold text-fg">{n}</p>
                  <p className="mt-0.5 text-xs text-muted">{d}</p>
                </div>
                <div className="shrink-0 text-end">
                  <p className="text-sm font-bold text-fg">{p} ج.م</p>
                  <span className="mt-1 inline-block rounded bg-primary px-2.5 py-1 text-xs font-semibold text-primary-fg">
                    أضف
                  </span>
                </div>
              </li>
            ),
          )}
        </ul>
        <div className="mt-3 flex items-center justify-between rounded bg-primary px-4 py-3 text-sm font-bold text-primary-fg">
          <span>السلة · ٣ أصناف</span>
          <span>٢٢٥ ج.م</span>
        </div>
        <p className="mt-2 text-center text-[11px] text-muted">
          رابط الطاولة مُعمّى ولا يكشف أي بيانات أخرى
        </p>
      </div>
    </Screen>
  );
}

const PANELS: Record<RoleKey, () => JSX.Element> = {
  owner: OwnerPreview,
  cashier: CashierPreview,
  kitchen: KitchenPreview,
  waiter: WaiterPreview,
  customer: CustomerPreview,
};

export function PreviewTabs() {
  const [active, setActive] = useState<RoleKey>('owner');
  const baseId = useId();
  const Panel = PANELS[active];

  return (
    <div>
      <div role="tablist" aria-label="معاينة حسب الدور" className="flex flex-wrap gap-2">
        {ROLES.map((r) => {
          const selected = r.key === active;
          return (
            <button
              key={r.key}
              type="button"
              role="tab"
              id={`${baseId}-tab-${r.key}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${r.key}`}
              onClick={() => setActive(r.key)}
              className={cn(
                'rounded px-4 py-2 text-sm font-semibold transition-colors',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
                selected
                  ? 'bg-primary text-primary-fg'
                  : 'border border-line bg-elevated text-muted hover:bg-surface hover:text-fg',
              )}
            >
              {r.label}
            </button>
          );
        })}
      </div>

      <p className="mt-3 text-sm text-muted">{ROLES.find((r) => r.key === active)!.blurb}</p>

      <div
        role="tabpanel"
        id={`${baseId}-panel-${active}`}
        aria-labelledby={`${baseId}-tab-${active}`}
        className="mt-4"
      >
        <Panel />
      </div>

      <p className="mt-3 text-center text-xs text-muted">
        بيانات العرض أعلاه توضيحية بالكامل ولا تمثل أي مطعم حقيقي.
      </p>
    </div>
  );
}
