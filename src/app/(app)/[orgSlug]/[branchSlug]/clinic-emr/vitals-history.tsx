'use client';

import { Activity, ArrowDown, ArrowUp, Minus } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { PatientChart, Vitals } from '@/modules/clinic/service';
import { VITALS, formatDate, outOfRange } from './shared';

type Row = { at: string; v: Vitals };

/**
 * Vitals over time: the latest reading of each measure with its trend
 * against the previous one, then the readings table. Readings outside the
 * usual adult range are marked, never hidden.
 */
export function VitalsHistory({ chart, tz }: { chart: PatientChart; tz: string }) {
  const rows: Row[] = chart.records.filter((r) => r.type === 'vitals').map((r) => ({ at: r.createdAt, v: r.vitals }));
  const measures = VITALS.filter((m) => rows.some((r) => r.v[m.key] !== null));

  const bmi = (() => {
    const w = rows.find((r) => r.v.weightKg !== null)?.v.weightKg;
    const h = rows.find((r) => r.v.heightCm !== null)?.v.heightCm;
    return w && h ? Math.round((w / (h / 100) ** 2) * 10) / 10 : null;
  })();

  return (
    <section className="space-y-3 rounded-lg border border-line bg-elevated p-4" aria-label="العلامات الحيوية" data-testid="emr-vitals">
      <h3 className="flex items-center gap-2 font-semibold"><Activity className="h-4 w-4 text-primary" aria-hidden="true" /> العلامات الحيوية</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">لا قياسات مسجّلة.</p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-2">
            {measures.map((m) => {
              const readings = rows.filter((r) => r.v[m.key] !== null);
              const latest = readings[0]!.v[m.key]!;
              const prev = readings[1]?.v[m.key] ?? null;
              const Trend = prev === null || prev === latest ? Minus : latest > prev ? ArrowUp : ArrowDown;
              const flag = outOfRange(m.key, latest);
              return (
                <div key={m.key} className={cn('rounded border p-2', flag ? 'border-warn/50 bg-warn/10' : 'border-line')}>
                  <dt className="text-xs text-muted">{m.label}</dt>
                  <dd className="flex items-center gap-1">
                    <span className={cn('lb-numeric text-lg font-bold', flag && 'text-warn')} dir="ltr">{latest}</span>
                    <span className="text-xs text-muted" dir="ltr">{m.unit}</span>
                    <Trend className="ms-auto h-4 w-4 text-muted" aria-label={prev === null ? 'قراءة واحدة' : latest > prev ? 'ارتفاع' : latest < prev ? 'انخفاض' : 'ثابت'} />
                  </dd>
                  {prev !== null && <span className="text-xs text-muted">السابق <span className="lb-numeric" dir="ltr">{prev}</span></span>}
                </div>
              );
            })}
            {bmi !== null && (
              <div className={cn('rounded border p-2', bmi < 18.5 || bmi >= 30 ? 'border-warn/50 bg-warn/10' : 'border-line')}>
                <dt className="text-xs text-muted">مؤشر كتلة الجسم</dt>
                <dd className="lb-numeric text-lg font-bold" dir="ltr">{bmi}</dd>
              </div>
            )}
          </dl>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted">
                <tr>
                  <th className="py-1 text-start font-medium">التاريخ</th>
                  <th className="py-1 text-start font-medium">الضغط</th>
                  <th className="py-1 text-start font-medium">النبض</th>
                  <th className="py-1 text-start font-medium">الحرارة</th>
                  <th className="py-1 text-start font-medium">السكر</th>
                  <th className="py-1 text-start font-medium">الوزن</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 12).map((r) => (
                  <tr key={r.at} className="border-t border-line">
                    <td className="py-1 text-muted">{formatDate(r.at, tz)}</td>
                    <Cell flag={outOfRange('systolicMmhg', r.v.systolicMmhg) || outOfRange('diastolicMmhg', r.v.diastolicMmhg)}>
                      {r.v.systolicMmhg !== null || r.v.diastolicMmhg !== null ? `${r.v.systolicMmhg ?? '—'}/${r.v.diastolicMmhg ?? '—'}` : '—'}
                    </Cell>
                    <Cell flag={outOfRange('pulseBpm', r.v.pulseBpm)}>{r.v.pulseBpm ?? '—'}</Cell>
                    <Cell flag={outOfRange('temperatureC', r.v.temperatureC)}>{r.v.temperatureC ?? '—'}</Cell>
                    <Cell flag={outOfRange('glucoseMgDl', r.v.glucoseMgDl)}>{r.v.glucoseMgDl ?? '—'}</Cell>
                    <Cell flag={false}>{r.v.weightKg ?? '—'}</Cell>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function Cell({ flag, children }: { flag: boolean; children: React.ReactNode }) {
  return <td className={cn('py-1 lb-numeric', flag && 'font-semibold text-warn')} dir="ltr">{children}</td>;
}
