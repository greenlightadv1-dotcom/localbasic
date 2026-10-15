import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChefHat, Clock, Flame, Gauge } from 'lucide-react';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { getKitchenAnalytics, type KitchenAnalytics } from '@/modules/restaurant/kds/service';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/patterns/page-header';
import { DataUnavailable } from '@/components/patterns/data-unavailable';
import { EmptyState } from '@/components/patterns/states';
import { cn } from '@/lib/cn';

export const metadata = { title: 'أداء المطبخ' };
export const dynamic = 'force-dynamic';

const PERIODS = [1, 7, 30] as const;

/** 754 s → "12:34". */
function mmss(sec: number | null) {
  if (sec === null || !Number.isFinite(sec)) return '—';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);

/**
 * Preparation time, measured by the KDS itself (0105): from the moment a
 * ticket reached the station to the moment its line was bumped ready
 * ("ticket time"), and from the first bump to ready ("cook time"). Per item,
 * per chef, per station — for the manager, not the line.
 */
export default async function KitchenAnalyticsPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; branchSlug: string };
  searchParams: { days?: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'restaurant.kitchen.analytics')) notFound();
  const days = PERIODS.includes(Number(searchParams.days) as (typeof PERIODS)[number]) ? Number(searchParams.days) : 7;

  let a: KitchenAnalytics;
  try {
    a = await getKitchenAnalytics(ctx, days);
  } catch (error) {
    return <DataUnavailable error={error} />;
  }
  const base = `/${ctx.organizationSlug}/${ctx.branchSlug}/kitchen/analytics`;

  return (
    <div className="space-y-5">
      <PageHeader
        title="أداء المطبخ"
        description="زمن التحضير من شاشة المطبخ: من وصول الطلب للمحطة حتى تجهيزه."
        actions={
          <nav className="flex gap-1" aria-label="الفترة">
            {PERIODS.map((d) => (
              <Link key={d} href={`${base}?days=${d}`} aria-current={d === days ? 'page' : undefined}
                className={cn('rounded border px-3 py-1.5 text-sm', d === days ? 'border-primary bg-primary-soft text-primary' : 'border-line bg-elevated text-muted')}>
                {d === 1 ? 'اليوم' : `آخر ${d} يوم`}
              </Link>
            ))}
          </nav>
        }
      />

      {a.overall.lines === 0 ? (
        <Card><EmptyState icon={ChefHat} title="لا توجد بيانات بعد" description="تظهر الأرقام بعد أن يجهّز المطبخ الأصناف من شاشة المطبخ." /></Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat icon={Clock} label="متوسط زمن الطلب" value={mmss(a.overall.avgTotalSec)} hint="من الإرسال للتجهيز" />
            <Stat icon={Flame} label="متوسط زمن الطهي" value={mmss(a.overall.avgCookSec)} hint="من البدء للتجهيز" />
            <Stat icon={Gauge} label="90% من الأصناف خلال" value={mmss(a.overall.p90TotalSec)} hint={`${a.overall.lines} صنف`} />
            <Stat icon={Flame} label="نسبة المتأخر" value={pct(a.overall.lateShare)} hint="فوق حد التأخير للمحطة" tone={(a.overall.lateShare ?? 0) > 0.15 ? 'danger' : undefined} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Table title="حسب المحطة" headers={['المحطة', 'أصناف', 'متوسط الزمن', 'متأخر']}
              rows={a.byStation.map((s) => [s.name, String(s.lines), mmss(s.avgTotalSec), pct(s.lateShare)])} />
            <Table title="حسب الشيف" headers={['الشيف', 'أصناف', 'زمن الطلب', 'زمن الطهي']}
              rows={a.byChef.map((c) => [c.name, String(c.lines), mmss(c.avgTotalSec), mmss(c.avgCookSec)])}
              empty="لم يُسجَّل من جهّز الأصناف بعد." />
          </div>
          <Table title="حسب الصنف (الأبطأ أولًا)" headers={['الصنف', 'مرات', 'كمية', 'متوسط الزمن', '90%', 'زمن الطهي']}
            rows={a.byItem.map((i) => [i.name, String(i.lines), String(i.units), mmss(i.avgTotalSec), mmss(i.p90TotalSec), mmss(i.avgCookSec)])} />
        </>
      )}
    </div>
  );
}

function Stat({ icon: Icon, label, value, hint, tone }: {
  icon: React.ComponentType<{ className?: string }>; label: string; value: string; hint: string; tone?: 'danger';
}) {
  return (
    <Card>
      <CardBody className="space-y-1">
        <p className="flex items-center gap-1.5 text-sm text-muted"><Icon className="h-4 w-4" aria-hidden="true" />{label}</p>
        <p className={cn('text-2xl font-bold lb-numeric', tone === 'danger' && 'text-danger')} dir="ltr">{value}</p>
        <p className="text-xs text-muted">{hint}</p>
      </CardBody>
    </Card>
  );
}

function Table({ title, headers, rows, empty }: { title: string; headers: string[]; rows: string[][]; empty?: string }) {
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      {rows.length === 0 ? <CardBody><p className="text-sm text-muted">{empty ?? 'لا توجد بيانات.'}</p></CardBody> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                {headers.map((h) => <th key={h} scope="col" className="p-3 text-start font-medium">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-line last:border-0">
                  {r.map((c, j) => <td key={j} className={cn('p-3', j === 0 ? 'font-medium' : 'lb-numeric')}>{c}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
