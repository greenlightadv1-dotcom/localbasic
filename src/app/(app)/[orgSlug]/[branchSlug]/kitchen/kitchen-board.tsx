'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertOctagon, Check, ChefHat, Clock, Coffee, Flame, StickyNote } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/patterns/states';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { useLiveOrders } from '@/lib/realtime/use-live-orders';
import { classifyTag, splitNote, TAG_STYLE } from '@/modules/restaurant/kds/tags';
import type { KitchenTicket } from '@/modules/restaurant/orders/service';
import type { Station } from '@/modules/restaurant/stations/service';
import { setOrderItemStationAction } from '../restaurant-actions';
import { bumpLinesAction } from './kds-actions';

const STATION_KIND_LABELS: Record<string, string> = { kitchen: 'مطبخ', bar: 'بار' };
const ALL = 'all';
const DEFAULT_WARN = 10;
const DEFAULT_LATE = 20;

/**
 * The board's ticket carries no money. That is enforced by the type coming
 * from listKitchenTickets(), which never selects a price column — not by this
 * component choosing not to render one.
 */
type Ticket = KitchenTicket;
type Line = Ticket['lines'][number];
type Stage = 'new' | 'cooking' | 'ready';

function minutesSince(iso: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}

function stageOf(lines: Line[]): Stage {
  if (lines.every((l) => l.prepStatus === 'ready')) return 'ready';
  if (lines.some((l) => l.prepStatus !== 'queued')) return 'cooking';
  return 'new';
}

const COLUMNS: { stage: Stage; title: string }[] = [
  { stage: 'new', title: 'جديد' },
  { stage: 'cooking', title: 'تحت التحضير' },
  { stage: 'ready', title: 'جاهز للتقديم' },
];

/** A short chime for a new ticket; silent where the browser blocks audio until a tap. */
function chime() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 988;
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
    setTimeout(() => void ctx.close(), 800);
  } catch {
    /* audio is a nicety */
  }
}

/**
 * The kitchen/bar display (KDS).
 *
 * Built for a tablet at arm's length in a hot, busy room: large type, high
 * contrast, no financial information of any kind.
 *
 * One component, two routes (/kitchen, /barista — 0080), each locked
 * server-side to its own station kind. Within that kind a screen can follow
 * ONE station (the grill, the fryer, the pass) and remembers it on this
 * device. Lines are bumped individually or a ticket at a time (0105): the
 * grill finishing its burgers does not mark the fries ready, and the order
 * itself turns ready only when every station's lines are.
 */
export function KitchenBoard({
  stationKind,
  tickets,
  stations,
  canReassign,
  organizationSlug,
  branchSlug,
  branchId,
}: {
  stationKind: 'kitchen' | 'bar';
  tickets: Ticket[];
  stations: Station[];
  canReassign: boolean;
  organizationSlug: string;
  branchSlug: string;
  branchId: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const scope = { organizationSlug, branchSlug };
  const [isPending, startTransition] = useTransition();
  const [, setTick] = useState(0);
  const myStations = useMemo(() => stations.filter((s) => s.kind === stationKind && s.isActive), [stations, stationKind]);
  const storageKey = `lb-kds-station-${stationKind}-${branchId}`;
  const [station, setStation] = useState<string>(ALL);

  // The screen at the grill stays on the grill.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved && (saved === ALL || myStations.some((s) => s.id === saved))) setStation(saved);
    } catch { /* storage unavailable: show every station */ }
  }, [storageKey, myStations]);
  function pickStation(id: string) {
    setStation(id);
    try { window.localStorage.setItem(storageKey, id); } catch { /* ignore */ }
  }

  // Ticket timers tick without a request.
  useEffect(() => {
    const tick = setInterval(() => setTick((t) => t + 1), 15_000);
    return () => clearInterval(tick);
  }, []);

  // New orders appear without anyone touching the screen: Realtime for an
  // instant refresh, a 5-second poll as the backstop (see useLiveOrders).
  useLiveOrders(branchId, stationKind);

  const stationById = new Map(stations.map((s) => [s.id, s]));
  const current = station === ALL ? null : stationById.get(station) ?? null;
  const visible = tickets
    .map((t) => ({
      ...t,
      lines: current ? t.lines.filter((l) => l.stationId === current.id) : t.lines,
    }))
    .filter((t) => t.lines.length > 0 && t.summary.status !== 'served');

  // A chime when a ticket this screen has not seen arrives.
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = new Set(visible.map((t) => t.summary.id));
    if (seen.current && [...ids].some((id) => !seen.current!.has(id))) chime();
    seen.current = ids;
  });

  function thresholds(lines: Line[]) {
    if (current) return { warn: current.warnAfterMin, late: current.lateAfterMin };
    const s = lines.map((l) => (l.stationId ? stationById.get(l.stationId) : undefined)).find(Boolean);
    return { warn: s?.warnAfterMin ?? DEFAULT_WARN, late: s?.lateAfterMin ?? DEFAULT_LATE };
  }

  function bump(itemIds: string[], status: 'queued' | 'preparing' | 'ready', message?: string) {
    if (itemIds.length === 0) return;
    startTransition(async () => {
      const result = await bumpLinesAction(scope, { itemIds, status });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      if (message) toast.success(message);
      router.refresh();
    });
  }

  function cycle(line: Line) {
    const next = line.prepStatus === 'queued' ? 'preparing' : line.prepStatus === 'preparing' ? 'ready' : 'preparing';
    bump([line.id], next);
  }

  function reassign(orderItemId: string, stationId: string) {
    startTransition(async () => {
      const result = await setOrderItemStationAction(scope, { orderItemId, stationId });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      router.refresh();
    });
  }

  const tabs = myStations.length > 1 && (
    <nav className="flex flex-wrap gap-2" aria-label="المحطة">
      {[{ id: ALL, name: 'كل المحطات' }, ...myStations].map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => pickStation(s.id)}
          aria-current={station === s.id ? 'page' : undefined}
          className={cn(
            'rounded-lg border-2 px-4 py-2 text-base font-semibold',
            station === s.id ? 'border-primary bg-primary text-primary-fg' : 'border-line bg-elevated text-fg',
          )}
          data-testid={`station-${s.name}`}
        >
          {s.name}
          <span className="ms-2 lb-numeric text-sm opacity-80">
            {tickets.filter((t) => t.summary.status !== 'served' && t.lines.some((l) => (s.id === ALL || l.stationId === s.id) && l.prepStatus !== 'ready')).length}
          </span>
        </button>
      ))}
    </nav>
  );

  if (visible.length === 0) {
    return (
      <div className="space-y-4">
        {tabs}
        <EmptyState
          icon={stationKind === 'kitchen' ? ChefHat : Coffee}
          title={current ? `لا توجد طلبات على ${current.name}` : stationKind === 'kitchen' ? 'لا توجد طلبات في المطبخ' : 'لا توجد طلبات في الباريستا'}
          description="ستظهر الطلبات هنا فور تأكيدها من الكاشير أو الكابتن."
        />
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="kds">
      {tabs}
      <div className="grid gap-4 lg:grid-cols-3">
        {COLUMNS.map((column) => {
          const columnTickets = visible.filter((t) => stageOf(t.lines) === column.stage);
          return (
            <section key={column.stage} aria-label={column.title} className="space-y-3">
              <h2 className="flex items-center justify-between text-base font-bold">
                {column.title}
                <Badge tone={column.stage === 'ready' ? 'success' : 'info'}>{columnTickets.length}</Badge>
              </h2>

              {columnTickets.length === 0 ? (
                <p className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-muted">لا شيء هنا</p>
              ) : (
                <ul className="space-y-3">
                  {columnTickets.map(({ summary, lines }) => {
                    const age = minutesSince(summary.confirmedAt ?? summary.placedAt);
                    const { warn: warnAt, late: lateAt } = thresholds(lines);
                    const done = column.stage === 'ready';
                    const late = !done && age >= lateAt;
                    const warn = !done && !late && age >= warnAt;
                    const open = lines.filter((l) => l.prepStatus !== 'ready');
                    const queued = lines.filter((l) => l.prepStatus === 'queued');
                    return (
                      <li
                        key={summary.id}
                        className={cn(
                          'rounded-lg border-2 bg-elevated shadow-card',
                          done ? 'border-emerald-500' : late ? 'border-red-600' : warn ? 'border-amber-500' : 'border-emerald-400',
                        )}
                        data-testid="kds-ticket"
                        data-timer={done ? 'done' : late ? 'late' : warn ? 'warn' : 'ok'}
                      >
                        <div
                          className={cn(
                            'flex items-start justify-between gap-2 rounded-t-md px-4 py-2',
                            done ? 'bg-emerald-50' : late ? 'bg-red-600 text-white' : warn ? 'bg-amber-400 text-amber-950' : 'bg-emerald-50',
                          )}
                        >
                          <div>
                            <p className="text-xl font-bold">
                              {summary.tableName ? <>طاولة <bdi>{summary.tableName}</bdi></> : 'سفري'}
                            </p>
                            <p className="lb-numeric text-sm opacity-80">#{summary.number}</p>
                          </div>
                          <span className={cn('flex items-center gap-1 rounded px-2 py-1 text-lg font-bold lb-numeric', late && 'animate-pulse')}>
                            {late ? <Flame className="h-5 w-5" aria-hidden="true" /> : <Clock className="h-5 w-5" aria-hidden="true" />}
                            {age}د
                          </span>
                        </div>

                        <ul className="space-y-1 px-3 py-2">
                          {lines.map((line) => {
                            const notes = line.note ? splitNote(line.note) : [];
                            const tags = [...line.modifiers.map((m) => m.name), ...notes];
                            return (
                              <li key={line.id} className={cn('rounded-md', line.prepStatus === 'preparing' && 'bg-amber-50')}>
                                <button
                                  type="button"
                                  onClick={() => cycle(line)}
                                  disabled={isPending || (summary.status === 'ready' && line.prepStatus === 'ready')}
                                  className="flex w-full items-start gap-2 rounded-md px-1 py-1.5 text-start disabled:cursor-default"
                                  aria-label={`${line.productName}: ${line.prepStatus === 'queued' ? 'ابدأ' : line.prepStatus === 'preparing' ? 'جاهز' : 'إرجاع للتحضير'}`}
                                  data-testid="kds-line"
                                  data-prep={line.prepStatus}
                                >
                                  <span
                                    className={cn(
                                      'mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border-2',
                                      line.prepStatus === 'ready' ? 'border-emerald-600 bg-emerald-600 text-white'
                                        : line.prepStatus === 'preparing' ? 'border-amber-500 bg-amber-100' : 'border-line',
                                    )}
                                    aria-hidden="true"
                                  >
                                    {line.prepStatus === 'ready' && <Check className="h-4 w-4" />}
                                    {line.prepStatus === 'preparing' && <Flame className="h-3.5 w-3.5 text-amber-600" />}
                                  </span>
                                  <span className="min-w-0 flex-1">
                                    <span className={cn('flex flex-wrap gap-x-2 text-lg font-semibold', line.prepStatus === 'ready' && 'text-muted line-through')}>
                                      <span className="lb-numeric text-primary">{line.quantity}×</span>
                                      <bdi>{line.productName}</bdi>
                                      {line.variantName !== 'default' && <span className="text-muted">— {line.variantName}</span>}
                                      {line.seatNo !== null && <span className="rounded bg-surface px-1.5 text-sm text-muted">مقعد {line.seatNo}</span>}
                                    </span>
                                    {tags.length > 0 && (
                                      <span className="mt-1 flex flex-wrap gap-1">
                                        {tags.map((tag, i) => {
                                          const kind = classifyTag(tag);
                                          return (
                                            <span
                                              key={i}
                                              className={cn('inline-flex items-center gap-1 rounded border-2 px-2 py-0.5 text-sm font-bold', TAG_STYLE[kind], kind !== 'option' && 'uppercase')}
                                              data-tag={kind}
                                            >
                                              {kind === 'allergy' && <AlertOctagon className="h-4 w-4" aria-hidden="true" />}
                                              {tag}
                                            </span>
                                          );
                                        })}
                                      </span>
                                    )}
                                  </span>
                                </button>
                                {line.prepNotes && (
                                  <p data-testid="prep-notes" className="ms-9 mb-1 whitespace-pre-line rounded border border-line bg-surface px-2 py-1 text-xs text-fg">
                                    <span className="font-semibold">تحضير: </span>
                                    {line.prepNotes}
                                  </p>
                                )}
                                {canReassign && stations.length > 1 && line.prepStatus !== 'ready' && (
                                  <label className="ms-9 mb-1 block">
                                    <span className="sr-only">نقل هذا الصنف لمحطة أخرى</span>
                                    <select
                                      value={line.stationId ?? ''}
                                      disabled={isPending}
                                      onChange={(e) => e.target.value && reassign(line.id, e.target.value)}
                                      className="h-7 rounded border border-line bg-elevated px-1.5 text-xs text-muted"
                                    >
                                      <option value="" disabled>نقل لمحطة أخرى…</option>
                                      {stations.map((s) => (
                                        <option key={s.id} value={s.id}>{s.name} ({STATION_KIND_LABELS[s.kind] ?? s.kind})</option>
                                      ))}
                                    </select>
                                  </label>
                                )}
                              </li>
                            );
                          })}
                        </ul>

                        {summary.note && (
                          <div className="mx-3 mb-2 flex flex-wrap gap-1 rounded bg-amber-50 p-2">
                            <StickyNote className="h-4 w-4 text-amber-700" aria-hidden="true" />
                            {splitNote(summary.note).map((n, i) => (
                              <span key={i} className={cn('rounded border-2 px-2 py-0.5 text-sm font-bold', TAG_STYLE[classifyTag(n)])}>{n}</span>
                            ))}
                          </div>
                        )}

                        <div className="px-3 pb-3">
                          {column.stage === 'new' && (
                            <Button size="touch" block disabled={isPending} onClick={() => bump(queued.map((l) => l.id), 'preparing', 'بدأ التحضير')} data-testid="kds-start">
                              ابدأ التحضير
                            </Button>
                          )}
                          {column.stage === 'cooking' && (
                            <Button size="touch" block disabled={isPending} onClick={() => bump(open.map((l) => l.id), 'ready', 'جاهز')} data-testid="kds-ready">
                              جاهز
                            </Button>
                          )}
                          {column.stage === 'ready' && summary.status !== 'ready' && (
                            <p className="text-center text-sm text-muted">بانتظار باقي المحطات</p>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
        <p className="sr-only" aria-live="polite">
          {visible.length} طلب في {current ? current.name : stationKind === 'kitchen' ? 'المطبخ' : 'الباريستا'}
        </p>
      </div>
    </div>
  );
}
