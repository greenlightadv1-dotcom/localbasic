/**
 * Pure helpers for the order staff trail and the monthly performance card.
 * No I/O, so the arithmetic that ends up in front of a manager is unit-tested.
 */

export type TrailEntry = {
  stage: string;
  actorId: string | null;
  actorName: string | null;
  at: string;
};

export type StageRow = {
  key: 'receiver' | 'confirmed' | 'preparing' | 'ready' | 'served' | 'cashier';
  label: string;
  actorName: string | null;
  at: string | null;
  /** Why nobody is named, when that is expected (a guest order has no receiver). */
  note?: string;
};

type OrderTimes = {
  channel: string;
  placed_at: string;
  confirmed_at: string | null;
  ready_at: string | null;
  served_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
};

const RECEIVER_LABEL: Record<string, string> = {
  waiter: 'الكابتن (استلم الطلب)',
  cashier: 'الكاشير (أنشأ الطلب)',
  qr: 'استلام الطلب',
  online: 'استلام الطلب',
};

const GUEST_NOTE: Record<string, string> = {
  qr: 'العميل (من رمز QR)',
  online: 'العميل (أونلاين)',
};

/** One row per accountable stage, in lifecycle order, naming who did it. */
export function buildStageRows(order: Pick<OrderTimes, 'channel'>, trail: TrailEntry[]): StageRow[] {
  const by = new Map(trail.map((t) => [t.stage, t]));
  const row = (
    key: StageRow['key'],
    label: string,
    entry: TrailEntry | undefined,
    note?: string,
  ): StageRow => ({
    key,
    label,
    actorName: entry?.actorName ?? null,
    at: entry?.at ?? null,
    ...(note && !entry?.actorName ? { note } : {}),
  });

  // Settlement is the payment; an order with nothing to pay (zero total) is
  // closed straight to 'completed', so that actor stands in.
  const cashier = by.get('paid') ?? by.get('completed');

  return [
    row('receiver', RECEIVER_LABEL[order.channel] ?? 'استلام الطلب', by.get('created'), GUEST_NOTE[order.channel]),
    row('confirmed', 'اعتماد الطلب', by.get('confirmed')),
    row('preparing', 'بدء التحضير (شيف / باريستا)', by.get('preparing')),
    row('ready', 'إنهاء التحضير (شيف / باريستا)', by.get('ready')),
    row('served', 'التقديم (الكابتن)', by.get('served')),
    row('cashier', 'الكاشير (الدفع والتسوية)', cashier),
  ];
}

export type OrderDurations = {
  /** Arrival → settled/served; null while the order is still open or was cancelled. */
  totalSeconds: number | null;
  /** Arrival → the kitchen starts. */
  waitSeconds: number | null;
  /** Kitchen starts → ready. */
  prepSeconds: number | null;
  /** Ready → served/settled. */
  handoverSeconds: number | null;
  /** Seconds since arrival, for an order still open at `now`. */
  openSeconds: number | null;
};

function between(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null;
  const s = (new Date(to).getTime() - new Date(from).getTime()) / 1000;
  return Number.isFinite(s) && s >= 0 ? Math.round(s) : null;
}

/**
 * Creation → kitchen completion → delivery/settlement.
 *
 * The kitchen's start is the 'preparing' event when one exists, else the
 * confirmation, else arrival — an order sent straight to ready has no separate
 * "preparing" step, and the wait/prep split then reads honestly as 0 wait.
 */
export function computeDurations(order: OrderTimes, trail: TrailEntry[], now = new Date()): OrderDurations {
  const by = new Map(trail.map((t) => [t.stage, t]));
  const prepStart = by.get('preparing')?.at ?? order.confirmed_at ?? order.placed_at;
  const ready = order.ready_at ?? by.get('ready')?.at ?? null;
  const end = order.completed_at ?? order.served_at ?? null;
  const open = !order.cancelled_at && !end;

  return {
    totalSeconds: order.cancelled_at ? null : between(order.placed_at, end),
    waitSeconds: ready ? between(order.placed_at, prepStart) : null,
    prepSeconds: between(prepStart, ready),
    handoverSeconds: between(ready, end),
    openSeconds: open ? between(order.placed_at, now.toISOString()) : null,
  };
}

const NUM = new Intl.NumberFormat('ar-EG');

/** 3725 → "١ س ٢ د"; sub-minute values keep seconds; null → "—". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${NUM.format(s)} ث`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0) return `${NUM.format(m)} د${s % 60 ? ` ${NUM.format(s % 60)} ث` : ''}`;
  return `${NUM.format(h)} س${m ? ` ${NUM.format(m)} د` : ''}`;
}

// ---------------------------------------------------------------------------
// Monthly performance
// ---------------------------------------------------------------------------

export type PerformanceTotals = {
  handled: number;
  created: number;
  confirmed: number;
  prepared: number;
  served: number;
  paid: number;
  collected_cents: number;
  created_sales_cents: number;
  avg_prep_seconds: number | null;
  prep_outliers: number;
};

export type PerformanceDay = PerformanceTotals & { day: string };

export type StaffPerformance = {
  monthStart: string;
  monthEnd: string;
  timezone: string;
  totals: PerformanceTotals;
  days: PerformanceDay[];
};

const EMPTY_TOTALS: PerformanceTotals = {
  handled: 0, created: 0, confirmed: 0, prepared: 0, served: 0, paid: 0,
  collected_cents: 0, created_sales_cents: 0, avg_prep_seconds: null, prep_outliers: 0,
};

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);

function toTotals(raw: Record<string, unknown> | undefined): PerformanceTotals {
  if (!raw) return { ...EMPTY_TOTALS };
  return {
    handled: num(raw.handled), created: num(raw.created), confirmed: num(raw.confirmed),
    prepared: num(raw.prepared), served: num(raw.served), paid: num(raw.paid),
    collected_cents: num(raw.collected_cents), created_sales_cents: num(raw.created_sales_cents),
    avg_prep_seconds: raw.avg_prep_seconds == null ? null : num(raw.avg_prep_seconds),
    prep_outliers: num(raw.prep_outliers),
  };
}

/** Normalises the RPC's jsonb (numbers may arrive as strings from bigint). */
export function parsePerformance(raw: unknown): StaffPerformance {
  const r = (raw ?? {}) as Record<string, unknown>;
  const days = Array.isArray(r.days) ? (r.days as Record<string, unknown>[]) : [];
  return {
    monthStart: String(r.month_start ?? ''),
    monthEnd: String(r.month_end ?? ''),
    timezone: String(r.timezone ?? 'Africa/Cairo'),
    totals: toTotals(r.totals as Record<string, unknown> | undefined),
    days: days.map((d) => ({ ...toTotals(d), day: String(d.day) })),
  };
}

/** "2026-10" → "2026-10-01"; anything else (or absent) → the given fallback month. */
export function monthStartFrom(param: string | undefined, today = new Date()): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(param ?? '');
  if (m) return `${m[1]}-${m[2]}-01`;
  return `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/** Shifts a "YYYY-MM-01" by whole months, returning "YYYY-MM". */
export function shiftMonth(monthStart: string, delta: number): string {
  const y = Number(monthStart.slice(0, 4));
  const m = Number(monthStart.slice(5, 7)) - 1 + delta;
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
