'use client';

import Link from 'next/link';
import { createContext, useContext, useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle, Download, Gauge, Megaphone, MessageCircle, RefreshCw, Settings2, ShoppingBasket, TrendingDown, TrendingUp, Users,
} from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { ConfirmDialog } from '@/components/ui/confirm';
import { useToast } from '@/components/ui/toast';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/cn';
import {
  SEGMENT_LABELS, SOS_STAGE_LABELS, crossSellSuggestions, deriveKpis, formatDuration, marginAt,
  scoreRfm, segmentCsv, sosBottleneck, summarizeSegments, whatsAppLink, type RfmCustomer, type Segment, type SosStage,
} from '@/modules/restaurant/analytics/calc';
import type { ExecutiveData } from '@/modules/restaurant/analytics/service';
import { ackMarginAlertAction, saveAnalyticsSettingsAction, scanMarginsAction, sendCampaignAction } from './actions';

type Scope = { organizationSlug: string; branchSlug: string };
const TYPE_LABELS: Record<string, string> = { dine_in: 'صالة', takeaway: 'تيك أواي', delivery: 'توصيل', pickup: 'استلام' };
const STAGES: SosStage[] = ['accept', 'queue', 'cook', 'handoff', 'delivery'];
const pct = (r: number | null | undefined, digits = 1) => (r === null || r === undefined || !Number.isFinite(r) ? '—' : `${(r * 100).toLocaleString('ar-EG', { maximumFractionDigits: digits })}%`);
const num = (n: number, d = 1) => n.toLocaleString('ar-EG', { maximumFractionDigits: d });

/** Dates in the organization's own time zone, so the server render and the browser agree. */
const TimeZone = createContext('Africa/Cairo');
function useDate() {
  const timeZone = useContext(TimeZone);
  return (iso: string | Date, opts: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString('ar-EG', { ...opts, timeZone });
}

const DEFAULT_MESSAGES: Record<Segment, string> = {
  vip: 'شكرًا لأنك من أهم عملائنا! هدية خاصة لطلبك القادم.',
  loyal: 'نحب وجودك معنا — خصم خاص لطلبك القادم.',
  active: 'جرّب أطباقنا الجديدة هذا الأسبوع.',
  new: 'سعداء بطلبك الأول! خصم لطلبك الثاني.',
  at_risk: 'وحشتنا! اطلب الآن واحصل على خصم خاص.',
  lapsed: 'مر وقت طويل! رجعنالك بعرض مخصوص.',
};

export function ExecutiveDashboard({ scope, basePath, currency, timeZone, days, allBranches, multiBranch, asOf, data, canCampaign }: {
  scope: Scope; basePath: string; currency: string; timeZone: string; days: number; allBranches: boolean; multiBranch: boolean; asOf: string;
  data: ExecutiveData; canCampaign: boolean;
}) {
  return (
    <TimeZone.Provider value={timeZone}>
      <Dashboard scope={scope} basePath={basePath} currency={currency} days={days} allBranches={allBranches} multiBranch={multiBranch} asOf={asOf} data={data} canCampaign={canCampaign} />
    </TimeZone.Provider>
  );
}

function Dashboard({ scope, basePath, currency, days, allBranches, multiBranch, asOf, data, canCampaign }: {
  scope: Scope; basePath: string; currency: string; days: number; allBranches: boolean; multiBranch: boolean; asOf: string;
  data: ExecutiveData; canCampaign: boolean;
}) {
  const date = useDate();
  const router = useRouter();
  const money = (c: number) => formatMoney(Math.round(c), currency);
  const [live, setLive] = useState(true);

  // A command center stays current: the server data is refetched every minute while visible.
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => { if (document.visibilityState === 'visible') router.refresh(); }, 60_000);
    return () => clearInterval(t);
  }, [live, router]);

  const k = useMemo(() => deriveKpis(data.kpis), [data.kpis]);
  const customers = useMemo(() => scoreRfm(data.rfm, { asOf: new Date(asOf), lapseDays: data.settings.lapseDays }), [data.rfm, asOf, data.settings.lapseDays]);
  const link = (d: number, all: boolean) => `${basePath}?days=${d}${all ? '&scope=all' : ''}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {[1, 7, 30, 90].map((d) => (
            <Link key={d} href={link(d, allBranches)} className={cn('rounded border px-3 py-1.5 text-sm', d === days ? 'border-primary bg-primary-soft text-primary' : 'border-line')}>
              {d === 1 ? 'آخر 24 ساعة' : `آخر ${d} يوم`}
            </Link>
          ))}
          {multiBranch && (
            <>
              <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
              <Link href={link(days, false)} className={cn('rounded border px-3 py-1.5 text-sm', !allBranches ? 'border-primary bg-primary-soft text-primary' : 'border-line')}>هذا الفرع</Link>
              <Link href={link(days, true)} className={cn('rounded border px-3 py-1.5 text-sm', allBranches ? 'border-primary bg-primary-soft text-primary' : 'border-line')}>كل الفروع</Link>
            </>
          )}
        </div>
        <label className="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> تحديث تلقائي كل دقيقة
          <span>· آخر تحديث {date(asOf, { hour: '2-digit', minute: '2-digit' })}</span>
        </label>
      </div>

      <ProfitSection data={data} k={k} money={money} />
      <MarginSection scope={scope} data={data} money={money} />
      <div className="grid gap-4 xl:grid-cols-2">
        <BasketSection data={data} />
        <SosSection data={data} />
      </div>
      <CustomerSection scope={scope} customers={customers} data={data} money={money} canCampaign={canCampaign} />
      <SettingsSection scope={scope} data={data} canCampaign={canCampaign} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Profit, waste, inventory
// ---------------------------------------------------------------------------
function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'bad' }) {
  return (
    <Card><CardBody>
      <p className="text-xs text-muted">{label}</p>
      <p className={cn('lb-numeric text-2xl font-bold', tone === 'bad' && 'text-danger')}>{value}</p>
      {sub && <p className="text-xs text-muted">{sub}</p>}
    </CardBody></Card>
  );
}

function ProfitSection({ data, k, money }: { data: ExecutiveData; k: ReturnType<typeof deriveKpis>; money: (c: number) => string }) {
  const r = data.kpis;
  const steps = [
    { label: 'صافي الإيراد', value: r.netRevenueCents, kind: 'total' as const },
    { label: 'تكلفة الخامات المستهلكة', value: -r.cogsCents },
    { label: 'هالك يدوي', value: -r.wasteManualCents },
    { label: 'العمالة (رواتب وعمولات)', value: -r.laborCents },
    { label: 'مصروفات تشغيل', value: -r.opexCents },
    { label: 'صافي الربح', value: k.netProfitCents, kind: 'total' as const },
  ];
  const max = Math.max(...steps.map((s) => Math.abs(s.value)), 1);
  return (
    <section className="space-y-3" aria-label="الربحية">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="exec-kpis">
        <Kpi label="صافي الإيراد" value={money(r.netRevenueCents)} sub={`${num(r.orders, 0)} طلب · متوسط ${money(k.avgTicketCents)}`} />
        <Kpi label="صافي الربح الفعلي" value={money(k.netProfitCents)} sub={`هامش ${pct(k.netMargin)}`} tone={k.netProfitCents < 0 ? 'bad' : 'good'} />
        <Kpi label="نسبة تكلفة الطعام" value={pct(k.foodCostRatio)} sub={`العمالة ${pct(k.laborRatio)} من الإيراد`} />
        <Kpi label="الهالك" value={pct(k.wasteOfSales)} sub={`${money(r.wasteCents)} · ${pct(k.wasteOfFoodCost)} من تكلفة الطعام`} />
        <Kpi label="دوران المخزون (في الفترة)" value={k.inventoryTurnover === null ? '—' : `${num(k.inventoryTurnover, 2)}×`}
          sub={k.daysOnHand === null ? 'لا استهلاك مسجل' : `يكفي المخزون نحو ${num(k.daysOnHand, 0)} يوم`} />
        <Kpi label="قيمة المخزون الآن" value={money(r.inventoryNowCents)} sub={`في بداية الفترة ${money(r.inventoryStartCents)}`} />
        <Kpi label="مجمل الربح" value={money(k.grossProfitCents)} sub="الإيراد ناقص الخامات" />
        <Kpi label="المرتجعات والخصومات" value={money(r.refundCents + r.discountCents)} sub={`مرتجع ${money(r.refundCents)} · خصم ${money(r.discountCents)}`} />
      </div>
      <Card>
        <CardHeader><CardTitle>من الإيراد إلى صافي الربح</CardTitle></CardHeader>
        <CardBody>
          <ul className="space-y-2 text-sm" data-testid="profit-bridge">
            {steps.map((s) => (
              <li key={s.label} className="grid grid-cols-[10rem_1fr_7rem] items-center gap-2 sm:grid-cols-[14rem_1fr_8rem]">
                <span className={cn(s.kind === 'total' && 'font-bold')}>{s.label}</span>
                <span className="h-3 overflow-hidden rounded-full bg-line" aria-hidden="true">
                  <span className={cn('block h-full rounded-full', s.kind === 'total' ? (s.value < 0 ? 'bg-danger' : 'bg-primary') : 'bg-fg/40')}
                    style={{ width: `${(Math.abs(s.value) / max) * 100}%` }} />
                </span>
                <span className={cn('lb-numeric text-end', s.kind === 'total' && 'font-bold', s.value < 0 && s.kind === 'total' && 'text-danger')}>{money(s.value)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">
            التكلفة من سجل استهلاك الخامات عند تأكيد الطلبات بمتوسط التكلفة. العمالة = مصروفات «رواتب» وعمولات المناديب في الخزينة.
            مشتريات «مستلزمات» النقدية ({money(r.suppliesCents)}) غير مخصومة هنا لأنها تدخل التكلفة عند الاستهلاك.
          </p>
        </CardBody>
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Margin alerts and live cost variance
// ---------------------------------------------------------------------------
function MarginSection({ scope, data, money }: { scope: Scope; data: ExecutiveData; money: (c: number) => string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const rows = data.variance.map((v) => {
    const base = marginAt(v.priceCents, v.baselineCost); const liveM = marginAt(v.priceCents, v.liveCost);
    return { ...v, base, liveM, change: base !== null && liveM !== null ? liveM - base : null };
  }).sort((a, b) => (a.change ?? 0) - (b.change ?? 0));
  const floor = data.settings.marginFloorBp / 10000;

  function scan() {
    start(async () => {
      const r = await scanMarginsAction(scope, {});
      if (!r.ok) { toast.error(r.error); return; }
      toast.success(r.data.opened ? `فُتح ${r.data.opened} تنبيه جديد` : 'لا تنبيهات جديدة'); router.refresh();
    });
  }
  function ack(id: string) {
    start(async () => {
      const r = await ackMarginAlertAction(scope, { alertId: id });
      if (!r.ok) { toast.error(r.error); return; }
      router.refresh();
    });
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2"><AlertTriangle className="h-5 w-5" aria-hidden="true" /> تنبيهات الهامش ({data.alerts.length})</CardTitle>
          <Button size="sm" variant="ghost" disabled={pending} onClick={scan}><RefreshCw className="h-4 w-4" aria-hidden="true" /> فحص الآن</Button>
        </CardHeader>
        <CardBody className="space-y-2">
          <p className="text-xs text-muted">يُفتح تنبيه تلقائيًا عندما ينزل هامش صنف عن {pct(floor, 0)} بعد ارتفاع تكلفة خاماته.</p>
          {data.alerts.length === 0 ? <p className="text-sm text-muted">كل الأصناف فوق الحد.</p> : (
            <ul className="divide-y divide-line text-sm" data-testid="margin-alerts">
              {data.alerts.map((a) => (
                <li key={a.id} className={cn('flex items-start justify-between gap-2 py-2', a.acknowledged && 'opacity-60')}>
                  <div>
                    <p className="font-medium">{a.name}</p>
                    <p className="text-xs text-muted">
                      هامش <span className="lb-numeric font-bold text-danger">{pct(a.marginBp / 10000)}</span> (الحد {pct(a.floorBp / 10000, 0)})
                      · تكلفة <span className="lb-numeric">{money(a.costCents)}</span> من <span className="lb-numeric">{money(a.priceCents)}</span>
                      {a.causeItem && <> · بسبب {a.causeItem}</>}
                    </p>
                  </div>
                  {!a.acknowledged && <Button size="sm" variant="ghost" disabled={pending} onClick={() => ack(a.id)}>تم الاطلاع</Button>}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>تغير تكلفة الأصناف (سعر الشراء الحالي مقابل بداية الفترة)</CardTitle></CardHeader>
        <CardBody className="p-0">
          {rows.length === 0 ? <p className="p-4 text-sm text-muted">لا أصناف لها وصفات بعد.</p> : (
            <div className="max-h-80 overflow-auto">
              <table className="w-full text-sm" data-testid="cost-variance">
                <thead className="sticky top-0 border-b border-line bg-elevated text-xs text-muted">
                  <tr><th className="p-2 text-start">الصنف</th><th className="p-2 text-end">السعر</th><th className="p-2 text-end">التكلفة قبل</th><th className="p-2 text-end">التكلفة الآن</th><th className="p-2 text-end">الهامش قبل → الآن</th></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.slice(0, 40).map((v) => (
                    <tr key={v.variantId}>
                      <td className="p-2">{v.name}</td>
                      <td className="lb-numeric p-2 text-end">{money(v.priceCents)}</td>
                      <td className="lb-numeric p-2 text-end">{money(v.baselineCost)}</td>
                      <td className="lb-numeric p-2 text-end">{money(v.liveCost)}<span className="block text-xs text-muted">دفتري {money(v.bookCost)}</span></td>
                      <td className="p-2 text-end">
                        <span className="lb-numeric">{pct(v.base)} → <span className={cn((v.liveM ?? 1) < floor && 'font-bold text-danger')}>{pct(v.liveM)}</span></span>
                        {v.change !== null && Math.abs(v.change) >= 0.001 && (
                          <span className={cn('ms-1 inline-flex items-center text-xs', v.change < 0 ? 'text-danger' : 'text-success')}>
                            {v.change < 0 ? <TrendingDown className="h-3 w-3" aria-label="انخفاض" /> : <TrendingUp className="h-3 w-3" aria-label="ارتفاع" />}
                            {num(Math.abs(v.change) * 100)} نقطة
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.priceChanges.length > 0 && (
            <div className="border-t border-line p-3 text-xs">
              <p className="mb-1 font-medium">أسعار الشراء التي تغيرت في الفترة</p>
              <ul className="flex flex-wrap gap-x-4 gap-y-1 text-muted">
                {data.priceChanges.map((p) => {
                  const ch = p.before && p.now ? (p.now - p.before) / p.before : null;
                  return <li key={p.itemId}>{p.name}: {ch === null ? 'أول شراء' : <span className={cn(ch > 0 ? 'text-danger' : 'text-success')}>{ch > 0 ? '+' : ''}{pct(ch)}</span>} · في {p.usedIn} صنف</li>;
                })}
              </ul>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Market basket
// ---------------------------------------------------------------------------
function BasketSection({ data }: { data: ExecutiveData }) {
  const suggestions = crossSellSuggestions(data.basket);
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><ShoppingBasket className="h-5 w-5" aria-hidden="true" /> سلة المشتريات والبيع المتقاطع</CardTitle></CardHeader>
      <CardBody className="space-y-4">
        {suggestions.length === 0 ? <p className="text-sm text-muted">لا توجد أصناف تُطلب معًا بما يكفي في هذه الفترة.</p> : (
          <div>
            <p className="mb-2 text-sm font-medium">اقتراحات للكاشير والكول سنتر</p>
            <ul className="space-y-1 text-sm" data-testid="cross-sell">
              {suggestions.slice(0, 8).map((s) => (
                <li key={s.forId} className="flex items-center justify-between gap-2 rounded bg-surface px-2 py-1">
                  <span>مع <strong>{s.forName}</strong> اقترح <strong>{s.suggestName}</strong></span>
                  <span className="lb-numeric shrink-0 text-xs text-muted">{pct(s.confidence, 0)} يضيفونه · ×{num(s.lift, 2)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {data.basket.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="basket-pairs">
              <thead className="border-b border-line text-xs text-muted">
                <tr><th className="p-2 text-start">الصنفان</th><th className="p-2 text-end">معًا</th><th className="p-2 text-end">من الطلبات</th><th className="p-2 text-end" title="أكبر من 1 = يُطلبان معًا أكثر من الصدفة">الارتباط</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.basket.slice(0, 10).map((p) => (
                  <tr key={`${p.aId}-${p.bId}`}>
                    <td className="p-2">{p.aName} + {p.bName}</td>
                    <td className="lb-numeric p-2 text-end">{p.together}</td>
                    <td className="lb-numeric p-2 text-end">{pct(p.support)}</td>
                    <td className="lb-numeric p-2 text-end">×{num(p.lift, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Speed of service
// ---------------------------------------------------------------------------
function SosSection({ data }: { data: ExecutiveData }) {
  const types = [...new Set(data.sos.map((r) => r.type))];
  const [type, setType] = useState(types.includes('delivery') ? 'delivery' : types[0] ?? '');
  const rows = data.sos.filter((r) => r.type === type);
  const total = rows.find((r) => r.stage === 'total');
  const bottleneck = sosBottleneck(data.sos, type);
  const maxP90 = Math.max(...rows.filter((r) => r.stage !== 'total').map((r) => r.p90S), 1);
  const maxHour = Math.max(...data.hourly.map((h) => h.avgReadyS), 1);
  const [hover, setHover] = useState<number | null>(null);

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2"><Gauge className="h-5 w-5" aria-hidden="true" /> سرعة الخدمة</CardTitle>
        {types.length > 0 && (
          <Select aria-label="نوع الطلب" value={type} onChange={(e) => setType(e.target.value)} className="h-8 w-36">
            {types.map((t) => <option key={t} value={t}>{TYPE_LABELS[t] ?? t}</option>)}
          </Select>
        )}
      </CardHeader>
      <CardBody className="space-y-4">
        {rows.length === 0 ? <p className="text-sm text-muted">لا طلبات مكتملة في الفترة.</p> : (
          <>
            <div className="flex flex-wrap gap-4 text-sm">
              <span>من الطلب حتى الإنجاز: <strong className="lb-numeric">{formatDuration(total?.p50S)}</strong> (الوسيط) · <strong className="lb-numeric">{formatDuration(total?.p90S)}</strong> لأبطأ 10%</span>
              {bottleneck && <Badge tone="warn">عنق الزجاجة: {SOS_STAGE_LABELS[bottleneck.stage]} ({pct(bottleneck.share, 0)} من الوقت)</Badge>}
            </div>
            <ul className="space-y-2 text-sm" data-testid="sos-stages">
              {STAGES.map((st) => {
                const r = rows.find((x) => x.stage === st);
                if (!r) return null;
                return (
                  <li key={st} className="grid grid-cols-[7rem_1fr_6rem] items-center gap-2">
                    <span className={cn(bottleneck?.stage === st && 'font-bold')}>{SOS_STAGE_LABELS[st]}</span>
                    <span className="relative h-3 rounded-full bg-line" aria-hidden="true">
                      <span className={cn('absolute inset-y-0 start-0 rounded-full', bottleneck?.stage === st ? 'bg-warn' : 'bg-primary')} style={{ width: `${(r.p50S / maxP90) * 100}%` }} />
                      <span className="absolute inset-y-[-3px] w-0.5 bg-fg" style={{ insetInlineStart: `${(r.p90S / maxP90) * 100}%` }} title="أبطأ 10%" />
                    </span>
                    <span className="lb-numeric text-end text-xs">{formatDuration(r.p50S)} / {formatDuration(r.p90S)}</span>
                  </li>
                );
              })}
            </ul>
            <p className="text-xs text-muted">الشريط: الوسيط · الخط: أبطأ 10% · (عدد الطلبات {total?.n ?? 0})</p>
          </>
        )}
        {data.hourly.length > 0 && (
          <div>
            <p className="mb-1 text-sm font-medium">متوسط الوقت حتى الجاهزية حسب ساعة الطلب</p>
            <div className="relative flex h-28 items-end gap-0.5" dir="ltr" data-testid="sos-hourly" onMouseLeave={() => setHover(null)}>
              {Array.from({ length: 24 }, (_, h) => {
                const row = data.hourly.find((x) => x.hour === h);
                return (
                  <button key={h} type="button" className="flex h-full flex-1 flex-col justify-end focus:outline-none"
                    onMouseEnter={() => setHover(h)} onFocus={() => setHover(h)} aria-label={row ? `الساعة ${h}: ${formatDuration(row.avgReadyS)} لـ ${row.orders} طلب` : `الساعة ${h}: لا طلبات`}>
                    <span className={cn('block w-full rounded-t-sm', row ? (hover === h ? 'bg-primary' : 'bg-primary/70') : 'bg-line')} style={{ height: row ? `${Math.max((row.avgReadyS / maxHour) * 100, 4)}%` : '2px' }} />
                  </button>
                );
              })}
              {hover !== null && (
                <div className="pointer-events-none absolute -top-2 rounded border border-line bg-elevated px-2 py-1 text-xs shadow" dir="rtl"
                  style={{ left: `${(hover / 24) * 100}%`, transform: 'translate(-30%, -100%)' }}>
                  {(() => { const row = data.hourly.find((x) => x.hour === hover); return row ? `${hover}:00 — ${formatDuration(row.avgReadyS)} · ${row.orders} طلب` : `${hover}:00 — لا طلبات`; })()}
                </div>
              )}
            </div>
            <div className="flex justify-between text-[10px] text-muted" dir="ltr"><span>0</span><span>6</span><span>12</span><span>18</span><span>23</span></div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// RFM segments and campaigns
// ---------------------------------------------------------------------------
function CustomerSection({ scope, customers, data, money, canCampaign }: {
  scope: Scope; customers: RfmCustomer[]; data: ExecutiveData; money: (c: number) => string; canCampaign: boolean;
}) {
  const summary = summarizeSegments(customers);
  const [selected, setSelected] = useState<Segment>('at_risk');
  const [campaign, setCampaign] = useState<Segment | null>(null);
  const list = customers.filter((c) => c.segment === selected).sort((a, b) => b.monetaryCents - a.monetaryCents);
  const recently = (c: RfmCustomer) => c.lastContactedAt && Date.now() - new Date(c.lastContactedAt).getTime() < 7 * 86_400_000;

  function download() {
    const blob = new Blob([segmentCsv(list.map((c) => ({ ...c, segment: c.segment })))], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `customers-${selected}.csv`; a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Users className="h-5 w-5" aria-hidden="true" /> شرائح العملاء (RFM) — {num(customers.length, 0)} عميل بهاتف</CardTitle></CardHeader>
      <CardBody className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-6" data-testid="rfm-segments">
          {summary.map((s) => (
            <div key={s.segment} className={cn('rounded border p-3 text-start', selected === s.segment ? 'border-primary bg-primary-soft' : 'border-line')}>
              <button type="button" className="block w-full text-start" onClick={() => setSelected(s.segment)} aria-pressed={selected === s.segment}>
                <p className="text-sm font-bold">{SEGMENT_LABELS[s.segment].title}</p>
                <p className="lb-numeric text-2xl font-bold">{num(s.count, 0)}</p>
                <p className="text-xs text-muted">{pct(s.share, 0)} · {money(s.monetaryCents)}</p>
                <p className="text-xs text-muted">{num(s.avgOrders)} طلب · آخر طلب منذ {num(s.avgRecencyDays, 0)} يوم</p>
              </button>
              {canCampaign && s.count > 0 && (
                <Button size="sm" variant="secondary" className="mt-2 w-full" onClick={() => setCampaign(s.segment)} data-testid={`campaign-${s.segment}`}>
                  <Megaphone className="h-4 w-4" aria-hidden="true" /> حملة
                </Button>
              )}
            </div>
          ))}
        </div>

        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm"><strong>{SEGMENT_LABELS[selected].title}:</strong> <span className="text-muted">{SEGMENT_LABELS[selected].hint}</span></p>
            {list.length > 0 && <Button size="sm" variant="ghost" onClick={download}><Download className="h-4 w-4" aria-hidden="true" /> تصدير CSV</Button>}
          </div>
          {list.length === 0 ? <p className="text-sm text-muted">لا عملاء في هذه الشريحة.</p> : (
            <div className="max-h-80 overflow-auto">
              <table className="w-full text-sm" data-testid="rfm-customers">
                <thead className="sticky top-0 border-b border-line bg-elevated text-xs text-muted">
                  <tr><th className="p-2 text-start">العميل</th><th className="p-2 text-end">آخر طلب</th><th className="p-2 text-end">الطلبات</th><th className="p-2 text-end">الإنفاق</th><th className="p-2 text-center">R·F·M</th><th className="p-2" /></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {list.slice(0, 200).map((c) => {
                    const wa = whatsAppLink(c.phone, DEFAULT_MESSAGES[c.segment]);
                    return (
                      <tr key={c.phoneKey}>
                        <td className="p-2">{c.name ?? '—'}<span className="block text-xs text-muted" dir="ltr">{c.phone}</span></td>
                        <td className="lb-numeric p-2 text-end">منذ {c.recencyDays} يوم</td>
                        <td className="lb-numeric p-2 text-end">{c.orders}</td>
                        <td className="lb-numeric p-2 text-end">{money(c.monetaryCents)}</td>
                        <td className="lb-numeric p-2 text-center text-xs">{c.r}·{c.f}·{c.m}</td>
                        <td className="p-2 text-end">
                          {recently(c) ? <Badge tone="neutral">رُوسل هذا الأسبوع</Badge> : wa && (
                            <a href={wa} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary"><MessageCircle className="h-3.5 w-3.5" aria-hidden="true" /> واتساب</a>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <CampaignHistory data={data} />
        {campaign && <CampaignDialog scope={scope} segment={campaign} customers={customers.filter((c) => c.segment === campaign)} defaults={data.settings} onClose={() => setCampaign(null)} />}
      </CardBody>
    </Card>
  );
}

function CampaignHistory({ data }: { data: ExecutiveData }) {
  const date = useDate();
  if (!data.campaigns.length) return null;
  return (
    <div>
      <p className="mb-1 text-sm font-medium">آخر الحملات</p>
      <ul className="divide-y divide-line text-sm" data-testid="campaigns">
        {data.campaigns.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
            <span>{c.name} {c.autoGenerated && <Badge tone="neutral">تلقائية</Badge>} <span className="text-xs text-muted">· {SEGMENT_LABELS[c.segment as Segment]?.title ?? c.segment} · {c.channel === 'sms' ? 'SMS' : 'واتساب'} · {date(c.createdAt, { day: 'numeric', month: 'short' })}</span></span>
            <span className="text-xs text-muted">
              {c.recipients} مستلم{c.promoCode && <> · الكود <code dir="ltr">{c.promoCode}</code></>} · أُرسل {c.sent} · بانتظار {c.pending} · فشل {c.failed}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CampaignDialog({ scope, segment, customers, defaults, onClose }: {
  scope: Scope; segment: Segment; customers: RfmCustomer[]; defaults: ExecutiveData['settings']; onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const date = useDate();
  const [pending, start] = useTransition();
  const eligible = customers.filter((c) => !(c.lastContactedAt && Date.now() - new Date(c.lastContactedAt).getTime() < 7 * 86_400_000));
  const [form, setForm] = useState({
    name: `${SEGMENT_LABELS[segment].title} — ${date(new Date(), { day: 'numeric', month: 'short' })}`, channel: defaults.channel,
    message: DEFAULT_MESSAGES[segment], discount: String(defaults.discountBp / 100), validDays: String(defaults.validDays),
  });

  function send() {
    start(async () => {
      const r = await sendCampaignAction(scope, {
        name: form.name, segment, channel: form.channel, message: form.message,
        phones: eligible.map((c) => ({ phone: c.phone, name: c.name })),
        discountPercent: form.discount.trim() ? Number(form.discount) : null, validDays: Number(form.validDays) || 14,
      });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success(`جُهزت الحملة لـ ${r.data.recipients} عميل${r.data.code ? ` — الكود ${r.data.code}` : ''}`);
      onClose(); router.refresh();
    });
  }

  return (
    <ConfirmDialog open title={`حملة: ${SEGMENT_LABELS[segment].title}`} tone="primary" busy={pending} confirmLabel={`إرسال لـ ${eligible.length}`}
      description={`${customers.length} عميل في الشريحة، ${customers.length - eligible.length} منهم وصلتهم رسالة هذا الأسبوع ولن يُراسَلوا.`}
      onCancel={onClose} onConfirm={send}>
      <div className="space-y-2" data-testid="campaign-dialog">
        <Field label="اسم الحملة">{(p) => <Input {...p} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={120} />}</Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label="القناة">{(p) => (
            <Select {...p} value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value as 'sms' | 'whatsapp' })}>
              <option value="whatsapp">واتساب</option><option value="sms">SMS</option>
            </Select>
          )}</Field>
          <Field label="خصم %" hint="فارغ = بدون كود">{(p) => <Input {...p} dir="ltr" inputMode="decimal" value={form.discount} onChange={(e) => setForm({ ...form, discount: e.target.value })} />}</Field>
          <Field label="صلاحية (يوم)">{(p) => <Input {...p} dir="ltr" inputMode="numeric" value={form.validDays} onChange={(e) => setForm({ ...form, validDays: e.target.value })} />}</Field>
        </div>
        <Field label="نص الرسالة" hint="يُضاف كود الخصم واسم المطعم تلقائيًا">{(p) => <Textarea {...p} rows={3} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} maxLength={500} />}</Field>
        <Alert tone="info">
          تُسجَّل الرسائل في صندوق الإرسال ويُنشأ كود خصم صالح لعدد المستلمين. الإرسال الآلي عبر SMS/واتساب يحتاج ربط مزود رسائل؛ بدونه
          تظهر الرسائل «فشل» في سجل الحملات — ويمكنك الإرسال يدويًا من روابط واتساب في الجدول أو تصدير CSV لمزود SMS.
        </Alert>
      </div>
    </ConfirmDialog>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function SettingsSection({ scope, data, canCampaign }: { scope: Scope; data: ExecutiveData; canCampaign: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const date = useDate();
  const s = data.settings;
  const [form, setForm] = useState({
    floor: String(s.marginFloorBp / 100), lapse: String(s.lapseDays), auto: s.autoReengage, channel: s.channel,
    discount: String(s.discountBp / 100), valid: String(s.validDays), message: s.message ?? '',
  });

  function save(e: React.FormEvent) {
    e.preventDefault();
    start(async () => {
      const r = await saveAnalyticsSettingsAction(scope, {
        marginFloorPercent: Number(form.floor), lapseDays: Number(form.lapse), autoReengage: form.auto, channel: form.channel,
        discountPercent: Number(form.discount), validDays: Number(form.valid), message: form.message || undefined,
      });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success('تم حفظ الإعدادات'); router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle className="flex items-center gap-2"><Settings2 className="h-5 w-5" aria-hidden="true" /> التنبيهات والاسترجاع التلقائي</CardTitle>
        <Button size="sm" variant="ghost" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'إخفاء' : 'تعديل'}</Button>
      </CardHeader>
      {!open ? (
        <CardBody className="text-sm text-muted">
          حد الهامش {s.marginFloorBp / 100}% · العميل منقطع بعد {s.lapseDays} يوم · الاسترجاع التلقائي {s.autoReengage ? `مفعّل (${s.channel === 'sms' ? 'SMS' : 'واتساب'}، خصم ${s.discountBp / 100}%)` : 'متوقف'}
          {s.lastRunAt && <> · آخر تشغيل {date(s.lastRunAt, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</>}
        </CardBody>
      ) : (
        <CardBody>
          <form onSubmit={save} className="grid gap-3 md:grid-cols-4" aria-label="إعدادات التحليلات">
            <Field label="حد الهامش الأدنى %" hint="تنبيه عند نزول هامش صنف عنه">{(p) => <Input {...p} dir="ltr" inputMode="decimal" value={form.floor} onChange={(e) => setForm({ ...form, floor: e.target.value })} />}</Field>
            <Field label="فترة الانقطاع (يوم)">{(p) => <Input {...p} dir="ltr" inputMode="numeric" value={form.lapse} onChange={(e) => setForm({ ...form, lapse: e.target.value })} />}</Field>
            <Field label="قناة الاسترجاع">{(p) => (
              <Select {...p} value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value as 'sms' | 'whatsapp' })}>
                <option value="whatsapp">واتساب</option><option value="sms">SMS</option>
              </Select>
            )}</Field>
            <Field label="خصم الاسترجاع %">{(p) => <Input {...p} dir="ltr" inputMode="decimal" value={form.discount} onChange={(e) => setForm({ ...form, discount: e.target.value })} />}</Field>
            <Field label="صلاحية الكود (يوم)">{(p) => <Input {...p} dir="ltr" inputMode="numeric" value={form.valid} onChange={(e) => setForm({ ...form, valid: e.target.value })} />}</Field>
            <div className="md:col-span-3">
              <Field label="رسالة الاسترجاع">{(p) => <Input {...p} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} maxLength={500} placeholder="وحشتنا! اطلب الآن واستخدم الكود للحصول على خصم." />}</Field>
            </div>
            <label className="flex items-center gap-2 text-sm md:col-span-4">
              <input type="checkbox" checked={form.auto} disabled={!canCampaign} onChange={(e) => setForm({ ...form, auto: e.target.checked })} />
              استرجاع تلقائي يومي: رسالة + كود خصم لكل عميل له طلبان أو أكثر وانقطع {form.lapse} يومًا (مرة كل 30 يومًا على الأكثر لكل عميل)
            </label>
            <div className="md:col-span-4"><Button type="submit" size="sm" disabled={pending}>حفظ</Button></div>
          </form>
        </CardBody>
      )}
    </Card>
  );
}
