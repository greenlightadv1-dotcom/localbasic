'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { AlertTriangle, Dog, HelpCircle, Star, Tractor } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/cn';
import { QUADRANT_LABELS, classifyMenu, type ClassifiedItem, type Quadrant } from '@/modules/restaurant/costing/calc';
import type { MenuMatrixRow } from '@/modules/restaurant/costing/service';

const ICON: Record<Quadrant, typeof Star> = { star: Star, plowhorse: Tractor, puzzle: HelpCircle, dog: Dog };
const ORDER: Quadrant[] = ['star', 'puzzle', 'plowhorse', 'dog'];
const pct = (n: number) => `${(n * 100).toLocaleString('ar-EG', { maximumFractionDigits: 1 })}%`;

export function MenuMatrix({ basePath, currency, days, allBranches, multiBranch, rows }: {
  basePath: string; currency: string; days: number; allBranches: boolean; multiBranch: boolean; rows: MenuMatrixRow[];
}) {
  const money = (c: number) => formatMoney(Math.round(c), currency);
  const result = useMemo(() => classifyMenu(rows), [rows]);
  const names = new Map(rows.map((r) => [r.variantId, r]));
  const revenue = rows.reduce((s, r) => s + r.revenueCents, 0);
  const costed = result.items.filter((i) => i.hasRecipe);
  const costedRevenue = costed.reduce((s, i) => s + i.revenueCents, 0);
  const foodCost = costedRevenue ? costed.reduce((s, i) => s + i.unitCostCents * i.qtySold, 0) / costedRevenue : 0;
  const noRecipe = result.items.filter((i) => !i.hasRecipe);
  const q = (k: Quadrant) => result.items.filter((i) => i.quadrant === k).sort((a, b) => b.totalMarginCents - a.totalMarginCents);
  const link = (d: number, all: boolean) => `${basePath}?days=${d}${all ? '&scope=all' : ''}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1">
        {[7, 30, 90].map((d) => (
          <Link key={d} href={link(d, allBranches)} className={cn('rounded border px-3 py-1.5 text-sm', d === days ? 'border-primary bg-primary-soft text-primary' : 'border-line')}>آخر {d} يوم</Link>
        ))}
        {multiBranch && (
          <>
            <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
            <Link href={link(days, false)} className={cn('rounded border px-3 py-1.5 text-sm', !allBranches ? 'border-primary bg-primary-soft text-primary' : 'border-line')}>هذا الفرع</Link>
            <Link href={link(days, true)} className={cn('rounded border px-3 py-1.5 text-sm', allBranches ? 'border-primary bg-primary-soft text-primary' : 'border-line')}>كل الفروع</Link>
          </>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="matrix-kpis">
        <Kpi label="الإيراد (سعر المنيو)" value={money(revenue)} />
        <Kpi label="هامش الأصناف" value={money(result.totalMarginCents)} />
        <Kpi label="نسبة تكلفة الطعام" value={costedRevenue ? pct(foodCost) : '—'} hint="للأصناف التي لها وصفة" />
        <Kpi label="الوحدات المباعة" value={result.totalUnits.toLocaleString('ar-EG')} />
      </div>

      {noRecipe.length > 0 && (
        <p className="flex items-start gap-1.5 rounded border border-line bg-surface p-2 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
          <span>{noRecipe.length} صنف بيع بدون وصفة، فتكلفته صفر وهامشه مضخّم: {noRecipe.slice(0, 6).map((i) => i.name).join('، ')}{noRecipe.length > 6 ? '…' : ''}.</span>
        </p>
      )}

      {result.items.length === 0 ? (
        <Card><CardBody><p className="py-8 text-center text-sm text-muted">لا مبيعات مكتملة في هذه الفترة.</p></CardBody></Card>
      ) : (
        <>
          <Card>
            <CardHeader><CardTitle>المصفوفة</CardTitle></CardHeader>
            <CardBody>
              <Scatter items={result.items} popularityUnits={result.popularityThreshold * result.totalUnits} avgMargin={result.avgMarginCents} money={money} />
              <p className="mt-2 text-xs text-muted">
                الخط الرأسي: حد الشعبية ({pct(result.popularityThreshold)} من الكميات = 70% من الحصة المتساوية).
                الخط الأفقي: متوسط هامش الحصة المرجّح ({money(result.avgMarginCents)}).
              </p>
            </CardBody>
          </Card>

          <div className="grid gap-3 md:grid-cols-2" data-testid="quadrants">
            {ORDER.map((k) => {
              const Icon = ICON[k];
              const list = q(k);
              return (
                <Card key={k}>
                  <CardHeader>
                    <CardTitle className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2"><Icon className="h-5 w-5" aria-hidden="true" /> {QUADRANT_LABELS[k].title}</span>
                      <Badge tone="neutral">{list.length}</Badge>
                    </CardTitle>
                    <p className="text-xs text-muted">{QUADRANT_LABELS[k].advice}</p>
                  </CardHeader>
                  <CardBody>
                    {list.length === 0 ? <p className="text-sm text-muted">لا أصناف.</p> : (
                      <ul className="space-y-1 text-sm">
                        {list.slice(0, 8).map((i) => (
                          <li key={i.variantId} className="flex justify-between gap-2">
                            <span className="truncate">{i.name}</span>
                            <span className="lb-numeric shrink-0 text-xs text-muted">{i.qtySold.toLocaleString('ar-EG')} × {money(i.unitMarginCents)}</span>
                          </li>
                        ))}
                        {list.length > 8 && <li className="text-xs text-muted">و{list.length - 8} أخرى في الجدول.</li>}
                      </ul>
                    )}
                  </CardBody>
                </Card>
              );
            })}
          </div>

          <Card>
            <CardHeader><CardTitle>كل الأصناف</CardTitle></CardHeader>
            <CardBody className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="matrix-table">
                  <thead className="border-b border-line text-xs text-muted">
                    <tr>
                      <th className="p-2 text-start">الصنف</th><th className="p-2 text-end">المباع</th><th className="p-2 text-end">الحصة</th>
                      <th className="p-2 text-end">متوسط السعر</th><th className="p-2 text-end">تكلفة الحصة</th><th className="p-2 text-end">هامش الحصة</th>
                      <th className="p-2 text-end">إجمالي الهامش</th><th className="p-2 text-start">التصنيف</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {[...result.items].sort((a, b) => b.totalMarginCents - a.totalMarginCents).map((i) => {
                      const Icon = ICON[i.quadrant];
                      return (
                        <tr key={i.variantId}>
                          <td className="p-2">{i.name}<span className="block text-xs text-muted">{names.get(i.variantId)?.categoryName ?? ''}</span></td>
                          <td className="lb-numeric p-2 text-end">{i.qtySold.toLocaleString('ar-EG')}</td>
                          <td className="lb-numeric p-2 text-end">{pct(i.mixShare)}</td>
                          <td className="lb-numeric p-2 text-end">{money(i.avgPriceCents)}</td>
                          <td className="lb-numeric p-2 text-end">{i.hasRecipe ? money(i.unitCostCents) : <span className="text-warn">بلا وصفة</span>}</td>
                          <td className={cn('lb-numeric p-2 text-end', i.unitMarginCents < 0 && 'text-danger')}>{money(i.unitMarginCents)}</td>
                          <td className="lb-numeric p-2 text-end">{money(i.totalMarginCents)}</td>
                          <td className="p-2"><span className="inline-flex items-center gap-1"><Icon className="h-4 w-4" aria-hidden="true" />{QUADRANT_LABELS[i.quadrant].title}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card><CardBody>
      <p className="text-xs text-muted">{label}</p>
      <p className="lb-numeric text-2xl font-bold">{value}</p>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </CardBody></Card>
  );
}

/**
 * Units sold (x) against margin per portion (y), one series. The quadrant is
 * carried by position and the labelled regions, not by colour; each point has
 * a hover/focus tooltip and the table below is the full data view.
 */
function Scatter({ items, popularityUnits, avgMargin, money }: {
  items: ClassifiedItem[]; popularityUnits: number; avgMargin: number; money: (c: number) => string;
}) {
  const [hover, setHover] = useState<ClassifiedItem | null>(null);
  const W = 720; const H = 360; const P = { l: 64, r: 16, t: 16, b: 40 };
  const maxX = Math.max(...items.map((i) => i.qtySold), popularityUnits) * 1.08 || 1;
  const ys = items.map((i) => i.unitMarginCents);
  const minY = Math.min(0, ...ys, avgMargin);
  const maxY = Math.max(...ys, avgMargin) * 1.1 || 1;
  const x = (v: number) => P.l + (v / maxX) * (W - P.l - P.r);
  const y = (v: number) => H - P.b - ((v - minY) / (maxY - minY || 1)) * (H - P.t - P.b);
  const tx = x(popularityUnits); const ty = y(avgMargin);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => minY + t * (maxY - minY));

  return (
    <div className="relative" dir="ltr">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="مصفوفة هندسة المنيو: الكمية المباعة مقابل هامش الحصة">
        {/* Quadrant regions, labelled (right = popular, top = profitable). */}
        <rect x={tx} y={P.t} width={W - P.r - tx} height={ty - P.t} className="fill-primary/5" />
        <rect x={P.l} y={ty} width={tx - P.l} height={H - P.b - ty} className="fill-fg/[0.03]" />
        {[
          { k: 'star' as const, x: W - P.r - 8, y: P.t + 16, anchor: 'end' },
          { k: 'puzzle' as const, x: P.l + 8, y: P.t + 16, anchor: 'start' },
          { k: 'plowhorse' as const, x: W - P.r - 8, y: H - P.b - 8, anchor: 'end' },
          { k: 'dog' as const, x: P.l + 8, y: H - P.b - 8, anchor: 'start' },
        ].map((l) => (
          <text key={l.k} x={l.x} y={l.y} textAnchor={l.anchor as 'start' | 'end'} className="fill-muted text-[12px] font-semibold">{QUADRANT_LABELS[l.k].title}</text>
        ))}
        {/* Axes and grid (recessive). */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} className="stroke-line" strokeWidth={1} />
            <text x={P.l - 6} y={y(t) + 4} textAnchor="end" className="fill-muted text-[10px]">{money(t)}</text>
          </g>
        ))}
        <line x1={P.l} x2={P.l} y1={P.t} y2={H - P.b} className="stroke-line" />
        <text x={(W + P.l) / 2} y={H - 8} textAnchor="middle" className="fill-muted text-[11px]">الكمية المباعة ←</text>
        <text x={14} y={(H - P.b) / 2} textAnchor="middle" transform={`rotate(-90 14 ${(H - P.b) / 2})`} className="fill-muted text-[11px]">هامش الحصة ←</text>
        {/* Thresholds. */}
        <line x1={tx} x2={tx} y1={P.t} y2={H - P.b} className="stroke-fg/40" strokeDasharray="4 4" strokeWidth={1.5} />
        <line x1={P.l} x2={W - P.r} y1={ty} y2={ty} className="stroke-fg/40" strokeDasharray="4 4" strokeWidth={1.5} />
        {/* Points: one series, a surface ring so overlaps stay readable. */}
        {items.map((i) => (
          <g key={i.variantId}>
            <circle cx={x(i.qtySold)} cy={y(i.unitMarginCents)} r={5} className="fill-primary stroke-elevated" strokeWidth={2} />
            <circle cx={x(i.qtySold)} cy={y(i.unitMarginCents)} r={12} fill="transparent" tabIndex={0} aria-label={`${i.name}: ${i.qtySold} مباع، هامش ${money(i.unitMarginCents)}`}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} />
          </g>
        ))}
      </svg>
      {hover && (
        <div className="pointer-events-none absolute z-10 rounded border border-line bg-elevated px-2 py-1 text-xs shadow" dir="rtl"
          style={{ left: `${(x(hover.qtySold) / W) * 100}%`, top: `${(y(hover.unitMarginCents) / H) * 100}%`, transform: 'translate(-50%, -120%)' }}>
          <p className="font-semibold text-fg">{hover.name}</p>
          <p className="text-muted">مباع <span className="lb-numeric">{hover.qtySold.toLocaleString('ar-EG')}</span> · هامش <span className="lb-numeric">{money(hover.unitMarginCents)}</span></p>
          <p className="text-muted">{QUADRANT_LABELS[hover.quadrant].title}</p>
        </div>
      )}
    </div>
  );
}
