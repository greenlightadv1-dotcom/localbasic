'use client';

import { AlertTriangle, MessageCircle, ScanLine } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Pill, Screen, Stat } from '../services/restaurant/preview-tabs';

/**
 * Retail and clinic screens for the role tour. Like the restaurant previews,
 * every value is hard-coded presentation data: rendered to anonymous
 * visitors, never reading the database.
 */

export function RetailCashierPreview() {
  return (
    <Screen title="نقطة البيع — سوبر ماركت الهدى">
      <div className="grid gap-4 md:grid-cols-[1.3fr_1fr]">
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded border-2 border-primary bg-surface px-3 py-2.5">
            <ScanLine className="h-5 w-5 text-primary" aria-hidden="true" />
            <span className="text-sm text-muted" dir="ltr">6223001234567</span>
            <span className="ms-auto rounded bg-success/15 px-2 py-0.5 text-[11px] font-bold text-success">تمت القراءة</span>
          </div>
          <ul className="divide-y divide-line rounded border border-line text-sm">
            {[
              ['لبن كامل الدسم ١ لتر', '×٢', '٧٠'],
              ['طماطم — ميزان', '١٫٢٥٠ كجم', '٢٥'],
              ['مكرونة ٤٠٠ جم', '×٣', '٤٥'],
              ['مكرونة ٤٠٠ جم — عرض ٢+١', 'هدية', '−١٥'],
            ].map(([n, q, v]) => (
              <li key={n} className="flex items-center justify-between gap-2 px-3 py-2">
                <span className="text-fg">{n}</span>
                <span className="flex items-center gap-3">
                  <span className="text-xs text-muted">{q}</span>
                  <span className={cn('w-10 text-end font-semibold', v!.startsWith('−') ? 'text-success' : 'text-fg')}>{v}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded border border-line p-3">
          <p className="mb-2 text-xs font-bold text-fg">العميل: أحمد سمير · رصيد ٣٠ ج.م</p>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between text-muted"><span>الإجمالي</span><span>١٤٠</span></div>
            <div className="flex justify-between text-success"><span>كود EID</span><span>−١٠</span></div>
            <div className="flex justify-between text-muted"><span>من رصيد العميل</span><span>−٣٠</span></div>
            <div className="flex justify-between border-t border-line pt-2 text-base font-extrabold text-fg"><span>المطلوب</span><span>١٠٠ ج.م</span></div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-center text-xs font-bold">
            <span className="rounded bg-primary py-2.5 text-primary-fg">نقدي</span>
            <span className="rounded border border-line py-2.5 text-fg">بطاقة</span>
          </div>
          <p className="mt-2 text-center text-[11px] text-muted">العروض والأسعار تُحسب على الخادم</p>
        </div>
      </div>
    </Screen>
  );
}

export function InventoryManagerPreview() {
  return (
    <Screen title="المخزون — مدير المخزن">
      <div className="grid gap-3 sm:grid-cols-4">
        {[
          { t: 'بانتظار الموافقة', n: '٢', tone: 'new' as const },
          { t: 'تمت الموافقة', n: '١', tone: 'prep' as const },
          { t: 'في الطريق', n: '٣', tone: 'prep' as const },
          { t: 'تم الاستلام', n: '١٢', tone: 'ready' as const },
        ].map((c) => (
          <div key={c.t} className="rounded border border-line bg-surface p-3">
            <div className="flex items-center justify-between"><span className="text-xs text-muted">{c.t}</span><Pill tone={c.tone}>{c.n}</Pill></div>
            {c.t === 'في الطريق' && <p className="mt-2 text-xs text-fg">المعادي ← مدينة نصر · ٤٠ صنف</p>}
          </div>
        ))}
      </div>
      <div className="mt-4 rounded border border-line">
        <p className="border-b border-line px-3 py-2 text-xs font-bold text-fg">اقتراحات إعادة الطلب</p>
        <ul className="divide-y divide-line text-sm">
          {[['زيت عباد الشمس ١ لتر', 'متبقي ٦ · الحد ٢٠', '٤٨'], ['أرز مصري ١ كجم', 'متبقي ١١ · الحد ٣٠', '٦٠'], ['سكر ١ كجم', 'متبقي ٩ · الحد ٢٥', '٥٠']].map(([n, h, q]) => (
            <li key={n} className="flex items-center justify-between gap-2 px-3 py-2">
              <span><span className="block text-fg">{n}</span><span className="text-xs text-warn">{h}</span></span>
              <span className="text-xs font-semibold text-fg">اطلب {q}</span>
            </li>
          ))}
        </ul>
        <div className="border-t border-line p-2 text-center">
          <span className="inline-block rounded bg-primary px-4 py-2 text-xs font-bold text-primary-fg">إنشاء أمر شراء للمورد</span>
        </div>
      </div>
    </Screen>
  );
}

export function ReceptionistPreview() {
  const slots = ['٤:٠٠', '٤:٣٠', '٥:٠٠', '٥:٣٠'];
  const book: Record<string, [string, string][]> = {
    'د. منى — باطنة': [['٤:٠٠', 'كريم سعيد'], ['٥:٠٠', 'سلمى علي']],
    'د. هاني — أطفال': [['٤:٣٠', 'يوسف (٥ سنوات)'], ['٥:٣٠', 'ليلى محمود']],
  };
  return (
    <Screen title="الاستقبال — مواعيد اليوم">
      <div className="grid gap-4 md:grid-cols-[1.4fr_1fr]">
        <div className="overflow-x-auto rounded border border-line">
          <table className="w-full min-w-[22rem] text-sm">
            <thead>
              <tr className="bg-surface text-xs text-muted">
                <th className="w-14 px-2 py-2 text-start font-semibold">الوقت</th>
                {Object.keys(book).map((d) => <th key={d} className="px-2 py-2 text-start font-semibold">{d}</th>)}
              </tr>
            </thead>
            <tbody>
              {slots.map((t) => (
                <tr key={t} className="border-t border-line">
                  <td className="px-2 py-2 text-xs text-muted">{t}</td>
                  {Object.entries(book).map(([d, list]) => {
                    const hit = list.find(([s]) => s === t);
                    return (
                      <td key={d} className="px-1.5 py-1.5">
                        {hit ? <span className="block rounded bg-primary-soft px-2 py-1 text-xs font-semibold text-primary">{hit[1]}</span>
                          : <span className="block rounded border border-dashed border-line px-2 py-1 text-[11px] text-muted">متاح</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="rounded border border-line p-3">
          <p className="mb-2 text-xs font-bold text-fg">قائمة الانتظار</p>
          <ul className="space-y-2 text-sm">
            {([['كريم سعيد', 'داخل الكشف', 'ready'], ['يوسف', 'في الانتظار ٨ د', 'prep'], ['سلمى علي', 'حجز ٥:٠٠', 'new']] as const).map(([n, s, tone]) => (
              <li key={n} className="flex items-center justify-between"><span className="text-fg">{n}</span><Pill tone={tone}>{s}</Pill></li>
            ))}
          </ul>
          <p className="mt-3 rounded bg-warn/10 px-2 py-1.5 text-[11px] text-warn">٥:٠٠ مع د. منى محجوز بالفعل — اختر موعدًا متاحًا</p>
        </div>
      </div>
    </Screen>
  );
}

export function DoctorPreview() {
  return (
    <Screen title="الكشف — د. منى · ملف كريم سعيد">
      <div className="flex flex-wrap items-center gap-2 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm">
        <AlertTriangle className="h-4 w-4 text-danger" aria-hidden="true" />
        <span className="font-bold text-danger">حساسية: بنسلين</span>
        <span className="text-muted">· مزمن: سكري · ٤١ سنة</span>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-4">
        <Stat label="الضغط" value="١٣٠/٨٥" />
        <Stat label="النبض" value="٩٠" />
        <Stat label="السكر" value="١٨٠" />
        <Stat label="الوزن" value="٨٢ كجم" />
      </div>
      <div className="mt-4 rounded border border-line p-3">
        <p className="mb-2 flex items-center gap-2 text-sm font-bold text-fg"><span className="font-serif text-lg text-primary" aria-hidden>℞</span> الروشتة</p>
        <ol className="space-y-1.5 text-sm">
          <li className="text-fg">١. ميتفورمين ٥٠٠ مجم — قرص مرتين يوميًا بعد الأكل · ٣٠ يوم</li>
          <li className="text-fg">٢. أتورفاستاتين ٢٠ مجم — قرص مساءً · ٣٠ يوم</li>
        </ol>
        <div className="mt-3 flex flex-wrap gap-2 text-xs font-bold">
          <span className="inline-flex items-center gap-1.5 rounded bg-[#25D366] px-3 py-2 text-white"><MessageCircle className="h-3.5 w-3.5" aria-hidden="true" /> إرسال على واتساب</span>
          <span className="rounded border border-line px-3 py-2 text-fg">طباعة</span>
        </div>
      </div>
      <p className="mt-3 text-center text-[11px] text-muted">الملف الطبي للطبيب فقط — الاستقبال لا يراه</p>
    </Screen>
  );
}

function OwnerBoard({ title, stats, topTitle, top, unit }: {
  title: string; stats: [string, string, string?][]; topTitle: string; top: [string, string][]; unit: string;
}) {
  return (
    <Screen title={title}>
      <div className="grid gap-3 sm:grid-cols-4">
        {stats.map(([l, v, h]) => <Stat key={l} label={l} value={v} hint={h} />)}
      </div>
      <div className="mt-4 rounded border border-line p-3">
        <p className="mb-2 text-xs font-bold text-fg">{topTitle}</p>
        <ul className="space-y-2 text-sm">
          {top.map(([n, c]) => (
            <li key={n} className="flex items-center justify-between"><span className="text-fg">{n}</span><span className="text-muted">{c} {unit}</span></li>
          ))}
        </ul>
      </div>
    </Screen>
  );
}

export function RetailOwnerPreview() {
  return (
    <OwnerBoard title="لوحة المالك — ٣ فروع"
      stats={[['مبيعات اليوم', '٤٢٬٨٠٠ ج.م', '+٨٪ عن أمس'], ['عدد الفواتير', '٣١٢'], ['هامش الربح', '٢٢٪'], ['أصناف تحت الحد', '١٤']]}
      topTitle="الأكثر مبيعًا" top={[['لبن كامل الدسم', '١٨٠'], ['أرز مصري ١ كجم', '١٢٤'], ['زيت عباد الشمس', '٩٧']]} unit="قطعة" />
  );
}

export function ClinicOwnerPreview() {
  return (
    <OwnerBoard title="لوحة المالك — العيادة"
      stats={[['إيراد اليوم', '١٢٬٦٠٠ ج.م', '+٥٪ عن أمس'], ['كشوفات', '٣٨'], ['نسبة الحضور', '٩١٪'], ['عمولات مستحقة', '٣٬٤٠٠ ج.م']]}
      topTitle="الأطباء اليوم" top={[['د. منى — باطنة', '١٦'], ['د. هاني — أطفال', '١٤'], ['د. سارة — جلدية', '٨']]} unit="كشف" />
  );
}
