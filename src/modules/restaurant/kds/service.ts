import 'server-only';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { staffDbError, toDataUnavailable } from '@/lib/errors';
import type { TenantContext } from '@/modules/core/tenancy/context';

/**
 * Kitchen display writes and kitchen analytics (0105). A bump moves lines at
 * ONE station; the database moves the order itself (preparing on the first
 * started line, ready when every station's lines are ready) in the same
 * transaction, and checks the station permission per line.
 */

export const bumpSchema = z.object({
  itemIds: z.array(z.string().uuid()).min(1).max(200),
  status: z.enum(['queued', 'preparing', 'ready']),
});

export const timersSchema = z
  .object({
    stationId: z.string().uuid(),
    warnAfterMin: z.coerce.number().int().min(1).max(240),
    lateAfterMin: z.coerce.number().int().min(2).max(480),
  })
  .refine((v) => v.lateAfterMin > v.warnAfterMin, {
    message: 'وقت التأخير يجب أن يكون أكبر من وقت التنبيه',
    path: ['lateAfterMin'],
  });

export const analyticsSchema = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) });

export async function bumpLines(ctx: TenantContext, input: z.infer<typeof bumpSchema>) {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('restaurant_kds_bump' as never, {
    p_org: ctx.organizationId, p_items: input.itemIds, p_status: input.status,
  } as never);
  if (error) throw staffDbError(error, 'bumpLines');
  return ((data ?? []) as unknown as { out_order_id: string; out_order_status: string }[]).map((r) => ({
    orderId: r.out_order_id,
    status: r.out_order_status,
  }));
}

export async function saveStationTimers(ctx: TenantContext, input: z.infer<typeof timersSchema>) {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('restaurant_station_timers_save' as never, {
    p_org: ctx.organizationId, p_station: input.stationId, p_warn: input.warnAfterMin, p_late: input.lateAfterMin,
  } as never);
  if (error) throw staffDbError(error, 'saveStationTimers');
}

type Agg = { lines: number; avgTotalSec: number | null; avgCookSec: number | null };
export type KitchenAnalytics = {
  days: number;
  overall: Agg & { p90TotalSec: number | null; lateShare: number | null };
  byItem: (Agg & { name: string; units: number; p90TotalSec: number | null })[];
  byChef: (Agg & { userId: string; name: string })[];
  byStation: { stationId: string | null; name: string; lines: number; avgTotalSec: number | null; lateShare: number | null }[];
};

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export async function getKitchenAnalytics(ctx: TenantContext, days: number): Promise<KitchenAnalytics> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('restaurant_kitchen_analytics' as never, {
    p_org: ctx.organizationId, p_branch: ctx.branchId, p_days: days,
  } as never);
  if (error) throw toDataUnavailable(error, 'getKitchenAnalytics');
  const d = (data ?? {}) as Record<string, unknown>;
  const o = (d.overall ?? {}) as Record<string, unknown>;
  const rows = (k: string) => ((d[k] ?? []) as Record<string, unknown>[]);
  return {
    days: Number(d.days ?? days),
    overall: {
      lines: Number(o.lines ?? 0),
      avgTotalSec: num(o.avg_total_sec),
      avgCookSec: num(o.avg_cook_sec),
      p90TotalSec: num(o.p90_total_sec),
      lateShare: num(o.late_share),
    },
    byItem: rows('by_item').map((r) => ({
      name: String(r.name), lines: Number(r.lines), units: Number(r.units),
      avgTotalSec: num(r.avg_total_sec), avgCookSec: num(r.avg_cook_sec), p90TotalSec: num(r.p90_total_sec),
    })),
    byChef: rows('by_chef').map((r) => ({
      userId: String(r.user_id), name: String(r.name), lines: Number(r.lines),
      avgTotalSec: num(r.avg_total_sec), avgCookSec: num(r.avg_cook_sec),
    })),
    byStation: rows('by_station').map((r) => ({
      stationId: (r.station_id as string | null) ?? null, name: String(r.name), lines: Number(r.lines),
      avgTotalSec: num(r.avg_total_sec), lateShare: num(r.late_share),
    })),
  };
}
