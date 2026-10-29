'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertOctagon, Bell, BellOff, Bike, Check, ChefHat, Coffee, ConciergeBell, Flame, Maximize2,
  RotateCcw, ShoppingBag, StickyNote, UtensilsCrossed,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { useLiveOrders } from '@/lib/realtime/use-live-orders';
import { useLiveRows } from '@/lib/realtime/use-live-rows';
import { classifyTag, splitNote, TAG_STYLE } from '@/modules/restaurant/kds/tags';
import type { KitchenTicket } from '@/modules/restaurant/orders/service';
import type { Station } from '@/modules/restaurant/stations/service';
import { setOrderStatusAction } from '../restaurant-actions';
import { bumpLinesAction } from '../kitchen/kds-actions';
import { clock, minutesSince, tone, type Scope } from './shared';

type Line = KitchenTicket['lines'][number];
type Prep = Line['prepStatus'];
type Column = 'pending' | 'preparing' | 'ready' | 'served';
const ALL = 'all';
/** A served ticket stays on the pass this long, then leaves the board. */
const SERVED_WINDOW_MIN = 15;
const NEW_FLASH_MS = 20_000;

const COLUMNS: { key: Column; title: string; accent: string }[] = [
  { key: 'pending', title: 'بالانتظار', accent: 'border-t-slate-400' },
  { key: 'preparing', title: 'تحت التحضير', accent: 'border-t-amber-500' },
  { key: 'ready', title: 'جاهز', accent: 'border-t-emerald-500' },
  { key: 'served', title: 'تم التقديم', accent: 'border-t-sky-500' },
];
const NEXT: Record<Prep, Prep> = { queued: 'preparing', preparing: 'ready', ready: 'ready' };
const KIND_LABEL = { kitchen: 'المطبخ', bar: 'البار' } as const;

function columnOf(status: string, lines: Line[]): Column {
  if (status === 'served') return 'served';
  if (lines.every((l) => l.prepStatus === 'ready')) return 'ready';
  if (lines.some((l) => l.prepStatus !== 'queued')) return 'preparing';
  return 'pending';
}

/**
 * The kitchen display. Tickets move through four columns — waiting,
 * preparing, ready, served — as each line is bumped; one station finishing
 * its lines never marks another station's ready (0105), and the order turns
 * ready only when every station's lines are.
 *
 * Live: order changes through useLiveOrders and every line bump through
 * useLiveRows (order lines joined Realtime in 0117), so the grill's "ready"
 * shows on the pass at once. Clocks tick each second against the station's
 * own warn/late minutes; a new ticket chimes and flashes, a ticket that runs
 * late sounds once and pulses red. No money of any kind is on this screen.
 */
export function KdsBoard({
  scope, basePath, organizationId, branchId, stationKind, kinds, tickets, stations, canServe,
}: {
  scope: Scope; basePath: string; organizationId: string; branchId: string;
  stationKind: 'kitchen' | 'bar'; kinds: ('kitchen' | 'bar')[];
  tickets: KitchenTicket[]; stations: Station[]; canServe: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [now, setNow] = useState(() => Date.now());
  const [station, setStation] = useState(ALL);
  const [sound, setSound] = useState(true);
  const [overrides, setOverrides] = useState<Record<string, Prep>>({});
  const boardRef = useRef<HTMLDivElement>(null);

  useLiveOrders(branchId, `hub-kds-${stationKind}`);
  useLiveRows(`hub-kds-items-${stationKind}-${branchId}`, [
    { table: 'restaurant_order_items', filter: `organization_id=eq.${organizationId}` },
  ]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  // Fresh data from the server replaces what this screen guessed.
  useEffect(() => { setOverrides({}); }, [tickets]);

  const myStations = useMemo(() => stations.filter((s) => s.kind === stationKind && s.isActive), [stations, stationKind]);
  const prefsKey = `lb-hub-kds-${stationKind}-${branchId}`;
  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(prefsKey) ?? '{}') as { station?: string; sound?: boolean };
      if (saved.station && (saved.station === ALL || myStations.some((s) => s.id === saved.station))) setStation(saved.station);
      if (typeof saved.sound === 'boolean') setSound(saved.sound);
    } catch { /* defaults */ }
  }, [prefsKey, myStations]);
  function savePrefs(next: { station?: string; sound?: boolean }) {
    try {
      const cur = JSON.parse(window.localStorage.getItem(prefsKey) ?? '{}') as object;
      window.localStorage.setItem(prefsKey, JSON.stringify({ ...cur, ...next }));
    } catch { /* ignore */ }
  }

  const stationById = useMemo(() => new Map(stations.map((s) => [s.id, s])), [stations]);
  const current = station === ALL ? null : stationById.get(station) ?? null;
  const thresholds = (lines: Line[]) => {
    const own = lines.map((l) => (l.stationId ? stationById.get(l.stationId) : undefined)).filter((s): s is Station => Boolean(s));
    const pool = own.length ? own : myStations;
    return {
      warn: pool.length ? Math.min(...pool.map((s) => s.warnAfterMin)) : 10,
      late: pool.length ? Math.min(...pool.map((s) => s.lateAfterMin)) : 20,
    };
  };

  const board = tickets
    .map((t) => ({
      ...t,
      lines: (current ? t.lines.filter((l) => l.stationId === current.id) : t.lines)
        .map((l) => (overrides[l.id] ? { ...l, prepStatus: overrides[l.id]! } : l)),
    }))
    .filter((t) => t.lines.length > 0)
    .filter((t) => t.summary.status !== 'served' || (t.summary.servedAt && minutesSince(t.summary.servedAt, now) < SERVED_WINDOW_MIN));

  // Alerts: a chime for each ticket this screen has not seen, a warning once
  // for each that crosses its late threshold.
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Record<string, number>>({});
  const lateAlerted = useRef(new Set<string>());
  useEffect(() => {
    const ids = board.filter((t) => t.summary.status !== 'served').map((t) => t.summary.id);
    if (seen.current) {
      const arrived = ids.filter((id) => !seen.current!.has(id));
      if (arrived.length) {
        if (sound) tone('new');
        const at = Date.now();
        setFresh((f) => ({ ...f, ...Object.fromEntries(arrived.map((id) => [id, at])) }));
      }
    }
    seen.current = new Set([...(seen.current ?? []), ...ids]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickets, station]);
  useEffect(() => {
    for (const t of board) {
      if (columnOf(t.summary.status, t.lines) === 'ready' || t.summary.status === 'served') continue;
      const since = t.summary.confirmedAt ?? t.summary.placedAt;
      if (minutesSince(since, now) >= thresholds(t.lines).late && !lateAlerted.current.has(t.summary.id)) {
        lateAlerted.current.add(t.summary.id);
        if (sound) tone('late');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now]);

  function bump(lines: Line[], status: Prep, label?: string) {
    const ids = lines.filter((l) => l.prepStatus !== status).map((l) => l.id);
    if (ids.length === 0) return;
    setOverrides((o) => ({ ...o, ...Object.fromEntries(ids.map((id) => [id, status])) }));
    start(async () => {
      const r = await bumpLinesAction(scope, { itemIds: ids, status });
      if (!r.ok) {
        setOverrides((o) => Object.fromEntries(Object.entries(o).filter(([k]) => !ids.includes(k))));
        toast.error(r.error);
        return;
      }
      if (label) toast.success(label);
      if (status === 'ready' && r.data.some((o) => o.status === 'ready') && sound) tone('ready');
      router.refresh();
    });
  }

  function serve(orderId: string, number: string) {
    start(async () => {
      const r = await setOrderStatusAction(scope, { orderId, status: 'served' });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success(`تم تقديم #${number}`);
      router.refresh();
    });
  }

  function fullscreen() {
    const el = boardRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.().catch(() => undefined);
  }

  const columns = COLUMNS.map((c) => ({ ...c, tickets: board.filter((t) => columnOf(t.summary.status, t.lines) === c.key) }));
  const lateCount = board.filter((t) => {
    const col = columnOf(t.summary.status, t.lines);
    return (col === 'pending' || col === 'preparing') && minutesSince(t.summary.confirmedAt ?? t.summary.placedAt, now) >= thresholds(t.lines).late;
  }).length;

  return (
    <div ref={boardRef} className="space-y-3 bg-surface p-0 [&:fullscreen]:overflow-y-auto [&:fullscreen]:p-4" data-testid="kds-board">
      <div className="flex flex-wrap items-center gap-2">
        {kinds.length > 1 && (
          <div className="flex rounded border border-line p-0.5">
            {kinds.map((k) => (
              <Link key={k} href={`${basePath}/restaurant?tab=kds&station=${k}`} aria-current={k === stationKind ? 'page' : undefined}
                className={cn('inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-semibold',
                  k === stationKind ? 'bg-primary text-primary-fg' : 'text-muted hover:text-fg')}>
                {k === 'kitchen' ? <ChefHat className="h-4 w-4" aria-hidden="true" /> : <Coffee className="h-4 w-4" aria-hidden="true" />}
                {KIND_LABEL[k]}
              </Link>
            ))}
          </div>
        )}
        {myStations.length > 1 && (
          <select value={station} onChange={(e) => { setStation(e.target.value); savePrefs({ station: e.target.value }); }}
            aria-label="المحطة" className="h-9 rounded border border-line bg-elevated px-2 text-sm">
            <option value={ALL}>كل محطات {KIND_LABEL[stationKind]}</option>
            {myStations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        {lateCount > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-red-600 px-3 py-1 text-sm font-bold text-white" role="status">
            <AlertOctagon className="h-4 w-4" aria-hidden="true" /> متأخر: <span className="lb-numeric">{lateCount}</span>
          </span>
        )}
        <div className="ms-auto flex items-center gap-1.5">
          <Button size="sm" variant={sound ? 'outline' : 'ghost'} aria-pressed={sound}
            onClick={() => { const s = !sound; setSound(s); savePrefs({ sound: s }); if (s) tone('new'); }}>
            {sound ? <Bell className="h-4 w-4" aria-hidden="true" /> : <BellOff className="h-4 w-4" aria-hidden="true" />}
            {sound ? 'الصوت مفعّل' : 'الصوت مكتوم'}
          </Button>
          <Button size="icon" variant="ghost" onClick={fullscreen} aria-label="ملء الشاشة"><Maximize2 className="h-4 w-4" aria-hidden="true" /></Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {columns.map((c) => (
          <section key={c.key} aria-label={c.title} className={cn('min-h-[12rem] rounded-lg border border-t-4 border-line bg-elevated/60 p-2', c.accent)}
            data-testid={`kds-col-${c.key}`}>
            <h2 className="mb-2 flex items-center justify-between px-1 text-base font-bold">
              {c.title} <span className="rounded-full bg-surface px-2 text-sm lb-numeric">{c.tickets.length}</span>
            </h2>
            <ul className="space-y-2">
              {c.tickets.map((t) => {
                const since = t.summary.confirmedAt ?? t.summary.placedAt;
                const mins = minutesSince(since, now);
                const { warn, late } = thresholds(t.lines);
                const active = c.key === 'pending' || c.key === 'preparing';
                const isLate = active && mins >= late;
                const isWarn = active && !isLate && mins >= warn;
                const isFresh = fresh[t.summary.id] && now - fresh[t.summary.id]! < NEW_FLASH_MS;
                const TypeIcon = t.summary.type === 'delivery' ? Bike : t.summary.type === 'takeaway' ? ShoppingBag : UtensilsCrossed;
                return (
                  <li key={t.summary.id}>
                    <article className={cn('rounded-lg border-2 bg-elevated p-2.5 shadow-sm',
                      isLate ? 'animate-pulse border-red-600' : isWarn ? 'border-amber-500' : 'border-line',
                      isFresh && 'ring-4 ring-sky-400')} data-testid={`kds-ticket-${t.summary.number}`}>
                      <header className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 text-lg font-black">
                          <TypeIcon className="h-4 w-4" aria-hidden="true" />
                          {t.summary.tableName ? <bdi>{t.summary.tableName}</bdi> : <span className="lb-numeric">#{t.summary.number}</span>}
                        </span>
                        <span className={cn('inline-flex items-center gap-1 rounded px-2 py-0.5 text-sm font-bold lb-numeric',
                          isLate ? 'bg-red-600 text-white' : isWarn ? 'bg-amber-400 text-amber-950' : 'bg-surface')}
                          aria-label={`منذ ${mins} دقيقة`}>
                          {isLate ? <Flame className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                          {c.key === 'served' && t.summary.servedAt ? clock(t.summary.servedAt, now) : clock(since, now)}
                        </span>
                      </header>
                      {t.summary.tableName && <p className="text-xs text-muted lb-numeric">#{t.summary.number}</p>}
                      {t.summary.note && (
                        <p className="mt-1 flex items-start gap-1 rounded bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
                          <StickyNote className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" /> {t.summary.note}
                        </p>
                      )}
                      <ul className="mt-2 space-y-1.5">
                        {t.lines.map((l) => (
                          <li key={l.id}>
                            <button type="button" disabled={pending || c.key === 'served' || l.prepStatus === 'ready'}
                              onClick={() => bump([l], NEXT[l.prepStatus])}
                              className={cn('w-full rounded border p-2 text-start transition disabled:cursor-default',
                                l.prepStatus === 'ready' ? 'border-emerald-300 bg-emerald-50 opacity-70 dark:bg-emerald-950/30'
                                  : l.prepStatus === 'preparing' ? 'border-amber-300 bg-amber-50 dark:bg-amber-950/30' : 'border-line hover:border-primary')}
                              aria-label={`${l.quantity} ${l.productName} — ${l.prepStatus === 'queued' ? 'ابدأ التحضير' : l.prepStatus === 'preparing' ? 'جاهز' : 'جاهز بالفعل'}`}
                              data-testid={`kds-line-${l.productName}`}>
                              <span className="flex items-start justify-between gap-2">
                                <span className={cn('text-base font-bold leading-tight', l.prepStatus === 'ready' && 'line-through')}>
                                  <span className="text-primary lb-numeric">{l.quantity}×</span> {l.productName}
                                  {l.variantName !== 'default' && <span className="font-normal text-muted"> — {l.variantName}</span>}
                                  {l.seatNo !== null && <span className="ms-1 text-xs font-normal text-muted">م{l.seatNo}</span>}
                                </span>
                                <span className="shrink-0 text-xs font-semibold">
                                  {l.prepStatus === 'ready' ? <Check className="h-4 w-4 text-emerald-600" aria-hidden="true" /> : l.prepStatus === 'preparing' ? 'يُحضَّر' : ''}
                                </span>
                              </span>
                              {(l.modifiers.length > 0 || l.note) && (
                                <span className="mt-1 flex flex-wrap gap-1">
                                  {[...l.modifiers.map((m) => m.name), ...(l.note ? splitNote(l.note) : [])].map((tag, i) => (
                                    <span key={i} className={cn('rounded border px-1.5 py-0.5 text-xs font-semibold', TAG_STYLE[classifyTag(tag)])}>{tag}</span>
                                  ))}
                                </span>
                              )}
                            </button>
                          </li>
                        ))}
                      </ul>
                      <footer className="mt-2 flex flex-wrap gap-1.5">
                        {c.key === 'pending' && (
                          <Button size="sm" variant="outline" className="flex-1" disabled={pending} onClick={() => bump(t.lines, 'preparing')}>ابدأ الكل</Button>
                        )}
                        {(c.key === 'pending' || c.key === 'preparing') && (
                          <Button size="sm" className="flex-1" disabled={pending} onClick={() => bump(t.lines, 'ready', `#${t.summary.number} جاهز`)} data-testid="kds-ready-all">
                            <Check className="h-4 w-4" aria-hidden="true" /> جاهز
                          </Button>
                        )}
                        {c.key === 'ready' && t.summary.status !== 'ready' && (
                          <>
                            <p className="w-full text-xs text-muted">بانتظار محطات أخرى في نفس الطلب.</p>
                            <Button size="sm" variant="ghost" disabled={pending} onClick={() => bump(t.lines, 'preparing')}>
                              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> رجوع
                            </Button>
                          </>
                        )}
                        {c.key === 'ready' && t.summary.status === 'ready' && canServe && (
                          <Button size="sm" className="flex-1" disabled={pending} onClick={() => serve(t.summary.id, t.summary.number)} data-testid="kds-serve">
                            <ConciergeBell className="h-4 w-4" aria-hidden="true" /> تم التقديم
                          </Button>
                        )}
                      </footer>
                    </article>
                  </li>
                );
              })}
              {c.tickets.length === 0 && <li className="px-1 py-6 text-center text-sm text-muted">—</li>}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
