'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Combine, Hand, LayoutTemplate, MousePointerClick, Save, Undo2, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { EmptyState } from '@/components/patterns/states';
import { useApproval } from '@/components/patterns/approval-dialog';
import { cn } from '@/lib/cn';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { useLiveOrders } from '@/lib/realtime/use-live-orders';
import type { FloorPlan, FloorPlanTable, WaitlistEntry } from '@/modules/restaurant/floor/service';
import type { TableShape } from '@/modules/restaurant/floor/schemas';
import { mergeTablesAction, saveLayoutAction, transferTableAction } from './actions';
import { TablePanel } from './table-panel';
import { WaitlistPanel } from './waitlist-panel';

type Scope = { organizationSlug: string; branchSlug: string };
export type FloorCan = { design: boolean; operate: boolean; setStatus: boolean; waitlist: boolean; cashier: boolean };
type Place = { x: number; y: number; w: number; h: number; shape: TableShape; sectionId: string | null };

/** The canvas is 16:10. Sizes are % of its WIDTH; positions are % of each axis. */
const ASPECT = 10 / 16;
const NO_ZONE = '__none__';

export const STATUS_TONE: Record<string, string> = {
  available: 'border-emerald-500 bg-emerald-100 text-emerald-950',
  occupied: 'border-red-500 bg-red-100 text-red-950',
  waiting_payment: 'border-amber-500 bg-amber-100 text-amber-950',
  reserved: 'border-blue-500 bg-blue-100 text-blue-950',
  cleaning: 'border-slate-400 bg-slate-100 text-slate-700',
};
export const STATUS_LABEL: Record<string, string> = {
  available: 'متاحة', occupied: 'مشغولة', waiting_payment: 'طلب الحساب', reserved: 'محجوزة', cleaning: 'تنظيف',
};

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const round1 = (v: number) => Math.round(v * 2) / 2;
/** Max y (% of height) that keeps a table of height h (% of width) on the canvas. */
const maxY = (h: number) => Math.max(0, 100 - h / ASPECT);

/** A grid slot: used to lay a whole zone out, and to park tables not yet placed. */
function autoPlace(index: number): { x: number; y: number } {
  const col = index % 6;
  const row = Math.floor(index / 6);
  return { x: 3 + col * 16, y: clamp(6 + row * 28, 0, 78) };
}

export function minutesSince(iso: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}

export function FloorView({
  scope, basePath, branchId, currency, plan, waitlist, can,
}: {
  scope: Scope; basePath: string; branchId: string; currency: string; plan: FloorPlan;
  waitlist: { open: WaitlistEntry[]; seatedToday: number } | null; can: FloorCan;
}) {
  const router = useRouter();
  const toast = useToast();
  const approval = useApproval(scope);
  const [pending, start] = useTransition();
  const [, setTick] = useState(0);
  const zones = useMemo(() => {
    const list = plan.sections.map((s) => ({ id: s.id, name: s.name }));
    if (plan.tables.some((t) => !t.sectionId || !plan.sections.some((s) => s.id === t.sectionId))) {
      list.push({ id: NO_ZONE, name: 'بدون منطقة' });
    }
    return list;
  }, [plan]);
  const [zone, setZone] = useState(zones[0]?.id ?? NO_ZONE);
  const [mode, setMode] = useState<'live' | 'design'>('live');
  const [draft, setDraft] = useState<Record<string, Place>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [pick, setPick] = useState<null | { kind: 'transfer'; from: string; orderId?: string } | { kind: 'merge'; target: string; chosen: string[] }>(null);

  // Live: orders (shared hook, with its 5 s backstop) plus tables and the waiting list.
  useLiveOrders(branchId, 'floor');
  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const nudge = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => router.refresh(), 300); };
    const channel = supabase.channel(`floor-${branchId}`);
    for (const table of ['restaurant_tables', 'restaurant_waitlist']) {
      channel.on('postgres_changes' as never, { event: '*', schema: 'public', table, filter: `branch_id=eq.${branchId}` } as never, nudge);
    }
    channel.subscribe();
    const tick = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => { if (timer) clearTimeout(timer); clearInterval(tick); void supabase.removeChannel(channel); };
  }, [branchId, router]);

  const zoneOf = (t: FloorPlanTable) =>
    t.sectionId && plan.sections.some((s) => s.id === t.sectionId) ? t.sectionId : NO_ZONE;

  // Tables never placed are parked along the bottom of their zone, clear of
  // the ones that were, until someone drags them where they belong.
  const placeOf = (t: FloorPlanTable, _index?: number): Place => {
    const d = draft[t.id];
    if (d) return d;
    let auto = { x: t.x ?? 0, y: t.y ?? 0 };
    if (t.x === null || t.y === null) {
      const parked = plan.tables
        .filter((x) => zoneOf(x) === zoneOf(t) && (x.x === null || x.y === null))
        .sort((a, b) => a.name.localeCompare(b.name, 'ar', { numeric: true }));
      const hasPlaced = plan.tables.some((x) => zoneOf(x) === zoneOf(t) && x.x !== null && x.y !== null);
      const i = parked.indexOf(t);
      auto = hasPlaced ? { x: 2 + (i % 7) * 14, y: 82 } : autoPlace(i);
    }
    return { ...auto, w: t.w, h: t.h, shape: t.shape, sectionId: t.sectionId };
  };

  const zoneTables = plan.tables
    .filter((t) => (draft[t.id] ? (draft[t.id]!.sectionId ?? NO_ZONE) : zoneOf(t)) === zone)
    .sort((a, b) => a.name.localeCompare(b.name, 'ar', { numeric: true }));
  const byId = new Map(plan.tables.map((t) => [t.id, t]));
  const selectedTable = selected ? byId.get(selected) ?? null : null;

  // ---- design ---------------------------------------------------------------
  const canvasRef = useRef<HTMLDivElement>(null);
  // Small tiles (a phone, a long zone) show their name only.
  const [canvasWidth, setCanvasWidth] = useState(1000);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => e && setCanvasWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const drag = useRef<null | { id: string; kind: 'move' | 'resize'; sx: number; sy: number; start: Place }>(null);

  function update(id: string, patch: Partial<Place>, base: Place) {
    setDraft((d) => ({ ...d, [id]: { ...(d[id] ?? base), ...patch } }));
  }

  function onPointerDown(e: React.PointerEvent, t: FloorPlanTable, place: Place, kind: 'move' | 'resize') {
    if (mode !== 'design') return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { id: t.id, kind, sx: e.clientX, sy: e.clientY, start: place };
    setSelected(t.id);
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!d || !rect) return;
    const dx = ((e.clientX - d.sx) / rect.width) * 100;
    const dy = ((e.clientY - d.sy) / rect.height) * 100;
    if (d.kind === 'move') {
      update(d.id, {
        x: round1(clamp(d.start.x + dx, 0, 100 - d.start.w)),
        y: round1(clamp(d.start.y + dy, 0, maxY(d.start.h))),
      }, d.start);
    } else {
      const w = round1(clamp(d.start.w + dx, 4, Math.min(60, 100 - d.start.x)));
      const h = d.start.shape === 'rect' ? round1(clamp(d.start.h + (dy * ASPECT), 4, 60)) : w;
      update(d.id, { w, h }, d.start);
    }
  }
  function onPointerUp() { drag.current = null; }

  function onKey(e: React.KeyboardEvent, t: FloorPlanTable, place: Place) {
    if (mode !== 'design') return;
    const step = e.shiftKey ? 5 : 1;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const m = moves[e.key];
    if (!m) return;
    e.preventDefault();
    update(t.id, {
      x: clamp(place.x + m[0], 0, 100 - place.w),
      y: clamp(place.y + m[1], 0, maxY(place.h)),
    }, place);
  }

  function arrange() {
    const next: Record<string, Place> = { ...draft };
    zoneTables.forEach((t, i) => {
      const base = placeOf(t, i);
      next[t.id] = { ...base, ...autoPlace(i), w: Math.min(base.w, 14), h: base.shape === 'rect' ? Math.min(base.h, 14) : Math.min(base.w, 14) };
    });
    setDraft(next);
  }

  function saveLayout() {
    // Everything on this branch's canvases that is not yet stored, or was moved.
    const tables = plan.tables
      .map((t) => {
        const index = plan.tables.filter((x) => zoneOf(x) === zoneOf(t)).sort((a, b) => a.name.localeCompare(b.name, 'ar', { numeric: true })).indexOf(t);
        const p = placeOf(t, index);
        return { t, p, dirty: Boolean(draft[t.id]) || t.x === null };
      })
      .filter((x) => x.dirty)
      .map(({ t, p }) => ({ id: t.id, sectionId: p.sectionId, x: p.x, y: p.y, w: p.w, h: p.h, shape: p.shape }));
    if (tables.length === 0) { toast.success('لا توجد تغييرات'); return; }
    start(async () => {
      const r = await saveLayoutAction(scope, { tables });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success('تم حفظ المخطط');
      setDraft({});
      router.refresh();
    });
  }

  // ---- live operations -------------------------------------------------------
  function onTableClick(t: FloorPlanTable) {
    if (mode === 'design') { setSelected(t.id); return; }
    if (pick?.kind === 'transfer') {
      if (t.id === pick.from) return;
      const from = byId.get(pick.from);
      start(async () => {
        const r = await transferTableAction(scope, { fromTableId: pick.from, toTableId: t.id, orderId: pick.orderId ?? null });
        if (!r.ok) { toast.error(r.error); return; }
        toast.success(`تم نقل ${pick.orderId ? 'الطلب' : 'الطاولة'} من ${from?.name ?? ''} إلى ${t.name}`);
        setPick(null);
        setSelected(t.id);
        router.refresh();
      });
      return;
    }
    if (pick?.kind === 'merge') {
      if (t.id === pick.target) return;
      setPick({ ...pick, chosen: pick.chosen.includes(t.id) ? pick.chosen.filter((x) => x !== t.id) : [...pick.chosen, t.id] });
      return;
    }
    setSelected(t.id);
  }

  function confirmMerge() {
    if (pick?.kind !== 'merge' || pick.chosen.length === 0) return;
    const { target, chosen } = pick;
    const go = async () => {
      const r = await mergeTablesAction(scope, { targetTableId: target, sourceTableIds: chosen });
      if (!r.ok) {
        if (r.code === 'approval_required') { approval.request('table.merge', target, null, go); return; }
        toast.error(r.error);
        return;
      }
      toast.success('تم دمج الطاولات في فاتورة واحدة');
      setPick(null);
      router.refresh();
    };
    start(go);
  }

  if (plan.tables.length === 0) {
    return (
      <Card>
        <EmptyState icon={LayoutTemplate} title="لا توجد طاولات بعد" description="أضف المناطق والطاولات من صفحة «الطاولات»، ثم صمّم المخطط هنا." />
      </Card>
    );
  }

  const dirtyCount = Object.keys(draft).length + (mode === 'design' ? plan.tables.filter((t) => t.x === null && !draft[t.id]).length : 0);
  const counts = plan.tables.reduce<Record<string, number>>((acc, t) => { acc[t.status] = (acc[t.status] ?? 0) + 1; return acc; }, {});

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
      <div className="min-w-0 space-y-3">
        {/* Zones and mode */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <nav className="flex flex-wrap gap-2" aria-label="المناطق">
            {zones.map((z) => (
              <button key={z.id} type="button" onClick={() => setZone(z.id)} aria-current={zone === z.id ? 'page' : undefined}
                className={cn('rounded border px-3 py-1.5 text-sm', zone === z.id ? 'border-primary bg-primary-soft text-primary' : 'border-line bg-elevated text-muted hover:text-fg')}
                data-testid={`zone-${z.id}`}>
                {z.name}
                <span className="ms-1 text-xs lb-numeric">({plan.tables.filter((t) => (draft[t.id]?.sectionId ?? zoneOf(t)) === z.id || (z.id === NO_ZONE && zoneOf(t) === NO_ZONE && !draft[t.id])).length})</span>
              </button>
            ))}
          </nav>
          {can.design && (
            <div className="flex gap-2">
              {mode === 'live' ? (
                <Button size="sm" variant="outline" onClick={() => { setMode('design'); setPick(null); }} data-testid="design-mode">
                  <LayoutTemplate className="h-4 w-4" aria-hidden="true" /> تصميم المخطط
                </Button>
              ) : (
                <>
                  <Button size="sm" variant="ghost" onClick={arrange}><Wand2 className="h-4 w-4" aria-hidden="true" /> ترتيب تلقائي</Button>
                  <Button size="sm" variant="ghost" onClick={() => { setDraft({}); setMode('live'); }}><Undo2 className="h-4 w-4" aria-hidden="true" /> إلغاء</Button>
                  <Button size="sm" onClick={saveLayout} disabled={pending} data-testid="save-layout">
                    <Save className="h-4 w-4" aria-hidden="true" /> حفظ {dirtyCount ? <span className="lb-numeric">({dirtyCount})</span> : null}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => { if (dirtyCount) saveLayout(); setMode('live'); }}>تم</Button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Legend */}
        <ul className="flex flex-wrap gap-3 text-xs" aria-label="دليل الألوان">
          {Object.entries(STATUS_LABEL).map(([k, label]) => (
            <li key={k} className="flex items-center gap-1.5">
              <span className={cn('inline-block h-3 w-3 rounded-sm border-2', STATUS_TONE[k])} aria-hidden="true" />
              {label} <span className="lb-numeric text-muted">{counts[k] ?? 0}</span>
            </li>
          ))}
        </ul>

        {pick && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-primary bg-primary-soft p-3 text-sm text-primary" role="status">
            <span className="flex items-center gap-2 font-semibold">
              {pick.kind === 'transfer' ? <Hand className="h-4 w-4" aria-hidden="true" /> : <Combine className="h-4 w-4" aria-hidden="true" />}
              {pick.kind === 'transfer'
                ? `اضغط على الطاولة الجديدة لنقل ${pick.orderId ? 'الطلب' : 'طلبات'} ${byId.get(pick.from)?.name ?? ''}`
                : `اختر الطاولات التي تُدمج مع ${byId.get(pick.target)?.name ?? ''} (${pick.chosen.length})`}
            </span>
            <span className="flex gap-2">
              {pick.kind === 'merge' && (
                <Button size="sm" onClick={confirmMerge} disabled={pending || pick.chosen.length === 0} data-testid="confirm-merge">دمج في فاتورة واحدة</Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setPick(null)}>إلغاء</Button>
            </span>
          </div>
        )}

        {/* Canvas */}
        <div
          ref={canvasRef}
          className={cn('relative w-full touch-none select-none overflow-hidden rounded-lg border border-line bg-elevated',
            mode === 'design' && 'bg-[linear-gradient(to_right,rgb(var(--lb-border))_1px,transparent_1px),linear-gradient(to_bottom,rgb(var(--lb-border))_1px,transparent_1px)] bg-[size:5%_8%]')}
          style={{ aspectRatio: '16 / 10', containerType: 'inline-size' }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onClick={() => { if (mode === 'design') setSelected(null); }}
          data-testid="floor-canvas"
        >
          {zoneTables.length === 0 && (
            <p className="absolute inset-0 grid place-items-center text-sm text-muted">لا توجد طاولات في هذه المنطقة.</p>
          )}
          {zoneTables.map((t, i) => {
            const p = placeOf(t, i);
            const orders = t.orders;
            const oldest = orders[0];
            const partner = t.mergedInto ? byId.get(t.mergedInto) : null;
            const compact = (p.w / 100) * canvasWidth < 76;
            const chosen = pick?.kind === 'merge' && (pick.chosen.includes(t.id) || pick.target === t.id);
            return (
              <button
                key={t.id}
                type="button"
                onClick={(e) => { e.stopPropagation(); onTableClick(t); }}
                onPointerDown={(e) => onPointerDown(e, t, p, 'move')}
                onKeyDown={(e) => onKey(e, t, p)}
                aria-label={`طاولة ${t.name} — ${STATUS_LABEL[t.status] ?? t.status}${orders.length ? ` — ${orders.length} طلب` : ''}`}
                aria-pressed={selected === t.id}
                className={cn(
                  'absolute flex flex-col items-center justify-center overflow-hidden border-2 p-0.5 text-center leading-tight shadow-card transition-shadow',
                  p.shape === 'round' ? 'rounded-full' : 'rounded-md',
                  STATUS_TONE[t.status] ?? STATUS_TONE.available,
                  mode === 'design' ? 'cursor-move' : 'cursor-pointer hover:shadow-lg',
                  selected === t.id && 'ring-4 ring-primary/60',
                  chosen && 'ring-4 ring-primary',
                  pick?.kind === 'transfer' && pick.from === t.id && 'opacity-50',
                )}
                style={{ left: `${p.x}%`, top: `${p.y}%`, width: `${p.w}cqw`, height: `${p.h}cqw` }}
                data-testid={`table-${t.name}`}
                data-status={t.status}
              >
                <span className="font-bold" style={{ fontSize: `clamp(10px, ${Math.min(p.w, p.h) / 4}cqw, 22px)` }}><bdi>{t.name}</bdi></span>
                {!compact && <span className="text-[10px] opacity-80 lb-numeric">{t.seats} مقاعد</span>}
                {mode === 'live' && oldest && !compact && (
                  <span className="text-[10px] font-semibold lb-numeric" title={`${orders.length} طلب`}>
                    <bdi>{minutesSince(oldest.placedAt)} د</bdi>{orders.length > 1 && <> · <bdi>{orders.length} فواتير</bdi></>}
                  </span>
                )}
                {mode === 'live' && partner && !compact && <span className="text-[10px] font-semibold">مع <bdi>{partner.name}</bdi></span>}
                {mode === 'live' && t.heldFor && !orders.length && !compact && <span className="max-w-full truncate text-[10px]">{t.heldFor}</span>}
                {mode === 'design' && selected === t.id && (
                  <span
                    role="presentation"
                    onPointerDown={(e) => onPointerDown(e, t, p, 'resize')}
                    className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize rounded-tl bg-primary"
                  />
                )}
              </button>
            );
          })}
        </div>

        {mode === 'design' ? (
          <DesignInspector
            table={selectedTable}
            place={selectedTable ? placeOf(selectedTable, zoneTables.indexOf(selectedTable)) : null}
            zones={zones}
            onChange={(patch) => selectedTable && update(selectedTable.id, patch, placeOf(selectedTable, zoneTables.indexOf(selectedTable)))}
          />
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <MousePointerClick className="h-3.5 w-3.5" aria-hidden="true" /> اضغط على طاولة لعرض طلباتها ونقلها أو دمجها أو تقسيم فاتورتها.
          </p>
        )}
      </div>

      <div className="space-y-4">
        {mode === 'live' && selectedTable && (
          <TablePanel
            key={selectedTable.id}
            scope={scope}
            basePath={basePath}
            currency={currency}
            table={selectedTable}
            tables={plan.tables}
            can={can}
            onClose={() => setSelected(null)}
            onTransfer={(orderId) => setPick({ kind: 'transfer', from: selectedTable.id, orderId })}
            onMerge={() => setPick({ kind: 'merge', target: selectedTable.mergedInto ?? selectedTable.id, chosen: [] })}
          />
        )}
        {can.waitlist && waitlist && (
          <WaitlistPanel scope={scope} entries={waitlist.open} seatedToday={waitlist.seatedToday} tables={plan.tables} />
        )}
      </div>
      {approval.dialog}
    </div>
  );
}

function DesignInspector({ table, place, zones, onChange }: {
  table: FloorPlanTable | null; place: Place | null; zones: { id: string; name: string }[];
  onChange: (patch: Partial<Place>) => void;
}) {
  if (!table || !place) {
    return <p className="text-xs text-muted">اسحب الطاولات لمكانها، واسحب المربع الصغير في ركن الطاولة لتغيير حجمها. الأسهم تحرك الطاولة المحددة (مع Shift خطوة أكبر).</p>;
  }
  return (
    <Card>
      <CardBody className="flex flex-wrap items-end gap-4 text-sm">
        <div className="font-bold">طاولة <bdi>{table.name}</bdi></div>
        <div className="space-y-1">
          <span className="block text-xs text-muted">الشكل</span>
          <div className="flex gap-1">
            {([['square', 'مربعة'], ['round', 'دائرية'], ['rect', 'مستطيلة']] as const).map(([k, label]) => (
              <button key={k} type="button" onClick={() => onChange({ shape: k, h: k === 'rect' ? place.h : place.w })}
                className={cn('rounded border px-2 py-1 text-xs', place.shape === k ? 'border-primary bg-primary-soft text-primary' : 'border-line')}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <label className="space-y-1">
          <span className="block text-xs text-muted">العرض</span>
          <input type="range" min={4} max={30} step={0.5} value={place.w} className="w-32 accent-primary"
            onChange={(e) => { const w = Number(e.target.value); onChange({ w, ...(place.shape === 'rect' ? {} : { h: w }) }); }} />
        </label>
        {place.shape === 'rect' && (
          <label className="space-y-1">
            <span className="block text-xs text-muted">الطول</span>
            <input type="range" min={4} max={30} step={0.5} value={place.h} className="w-32 accent-primary"
              onChange={(e) => onChange({ h: Number(e.target.value) })} />
          </label>
        )}
        <label className="space-y-1">
          <span className="block text-xs text-muted">المنطقة</span>
          <select className="h-8 rounded border border-line bg-elevated px-2 text-sm" value={place.sectionId ?? NO_ZONE}
            onChange={(e) => onChange({ sectionId: e.target.value === NO_ZONE ? null : e.target.value })}>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
        </label>
      </CardBody>
    </Card>
  );
}
