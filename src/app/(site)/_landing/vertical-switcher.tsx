'use client';

import { useId, useRef } from 'react';
import Link from 'next/link';
import { ArrowLeft, Check } from 'lucide-react';
import { WhatsAppCta } from '@/components/patterns/site-chrome';
import { cn } from '@/lib/cn';
import { SECTORS, SECTOR_BY_KEY, type SectorKey } from './sectors';
import { useSector } from './use-sector';

/**
 * "Which business are you?" — three tabs, one panel. The panel keeps one
 * fixed layout for every sector (headline, six features, a day in four
 * steps, three proof points, a call to action) so switching reads as the
 * same product dressed for a different trade, not three different sites;
 * only the words, icons and the accent change, with a short fade.
 */
export function VerticalSwitcher() {
  const [active, setActive] = useSector();
  const baseId = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const s = SECTOR_BY_KEY[active];

  // Arrow keys move between tabs (RTL: right is "previous").
  function onKey(e: React.KeyboardEvent, i: number) {
    const dir = e.key === 'ArrowLeft' ? 1 : e.key === 'ArrowRight' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const next = (i + dir + SECTORS.length) % SECTORS.length;
    setActive(SECTORS[next]!.key);
    tabs.current[next]?.focus();
  }

  return (
    <div>
      <div role="tablist" aria-label="اختر نوع نشاطك"
        className="mx-auto grid max-w-3xl grid-cols-3 gap-1.5 rounded-lg border border-line bg-elevated p-1.5 shadow-card">
        {SECTORS.map((x, i) => {
          const selected = x.key === active;
          return (
            <button key={x.key} ref={(el) => { tabs.current[i] = el; }} type="button" role="tab"
              id={`${baseId}-tab-${x.key}`} aria-selected={selected} aria-controls={`${baseId}-panel`}
              tabIndex={selected ? 0 : -1} onClick={() => setActive(x.key as SectorKey)} onKeyDown={(e) => onKey(e, i)}
              className={cn(
                'flex flex-col items-center gap-1.5 rounded px-2 py-3 text-center text-xs font-bold transition-colors sm:flex-row sm:justify-center sm:gap-2 sm:text-sm',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
                selected ? x.accent.solid : 'text-muted hover:bg-surface hover:text-fg',
              )}
              data-testid={`sector-tab-${x.key}`}>
              <x.icon className="h-5 w-5 shrink-0" aria-hidden="true" />
              {x.label}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${active}`}
        className={cn('relative mt-6 overflow-hidden rounded-lg border border-t-4 border-line bg-elevated shadow-card', s.accent.edge)}>
        <div aria-hidden className={cn('pointer-events-none absolute inset-0 bg-gradient-to-b to-transparent', s.accent.wash)} />
        {/* key= remounts the content so each switch fades in fresh. */}
        <div key={active} className="relative animate-fade-up p-5 [animation-duration:350ms] sm:p-8">
          <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
            <div className="space-y-6">
              <div className="space-y-2">
                <span className={cn('inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold', s.accent.soft)}>
                  <s.icon className="h-3.5 w-3.5" aria-hidden="true" /> {s.label}
                </span>
                <h3 className="text-xl font-extrabold leading-snug text-fg sm:text-2xl">{s.tagline}</h3>
                <p className="max-w-2xl text-sm leading-relaxed text-muted sm:text-base">{s.lead}</p>
              </div>

              <ul className="grid gap-3 sm:grid-cols-2">
                {s.features.map((f) => (
                  <li key={f.title} className="flex gap-3 rounded-lg border border-line bg-elevated/80 p-4 transition-shadow hover:shadow-pop">
                    <span className={cn('inline-flex h-10 w-10 shrink-0 items-center justify-center rounded', s.accent.soft)}>
                      <f.icon className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <span>
                      <span className="block font-bold text-fg">{f.title}</span>
                      <span className="mt-1 block text-sm leading-relaxed text-muted">{f.body}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <aside className="space-y-5">
              <div className="rounded-lg border border-line bg-surface p-4">
                <p className="mb-3 text-sm font-bold text-fg">يوم عمل على النظام</p>
                <ol className="relative space-y-4 border-s-2 border-line ps-5">
                  {s.flow.map((step, i) => (
                    <li key={step} className="relative text-sm text-fg">
                      <span className={cn('absolute -start-[1.95rem] top-0 inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-white', s.accent.dot)}>
                        {i + 1}
                      </span>
                      {step}
                    </li>
                  ))}
                </ol>
              </div>

              <dl className="grid grid-cols-3 gap-2 text-center">
                {s.stats.map(([v, l]) => (
                  <div key={l} className="rounded-lg border border-line bg-elevated p-2.5">
                    <dt className="sr-only">{l}</dt>
                    <dd className="text-base font-black text-fg">{v}</dd>
                    <dd className="mt-0.5 text-[11px] leading-tight text-muted">{l}</dd>
                  </div>
                ))}
              </dl>

              <ul className="space-y-1.5 text-sm text-muted">
                {['نفس الخزينة والتقارير والصلاحيات', 'فروع متعددة من حساب واحد', 'تدريب ودعم بالعربية'].map((t) => (
                  <li key={t} className="flex items-center gap-2"><Check className="h-4 w-4 text-success" aria-hidden="true" />{t}</li>
                ))}
              </ul>

              <div className="flex flex-wrap gap-2">
                <WhatsAppCta message={s.whatsapp} className="h-11 flex-1 px-4 text-sm">{s.cta}</WhatsAppCta>
                {s.detailsHref && (
                  <Link href={s.detailsHref}
                    className="inline-flex h-11 items-center justify-center gap-1.5 rounded border border-line bg-elevated px-4 text-sm font-semibold text-fg hover:bg-surface">
                    التفاصيل <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                  </Link>
                )}
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}
