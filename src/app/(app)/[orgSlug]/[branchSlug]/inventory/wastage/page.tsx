import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { getWastage } from '@/modules/restaurant/wastage/service';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { DataUnavailable } from '@/components/patterns/data-unavailable';
import { PageHeader } from '@/components/patterns/page-header';
import { WastageBoard } from './wastage-board';

export const metadata = { title: 'الهالك' };
export const dynamic = 'force-dynamic';

const PERIODS = [1, 7, 30, 90] as const;

export default async function WastagePage({ params, searchParams }: {
  params: { orgSlug: string; branchSlug: string }; searchParams: { days?: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!ctx.enabledModules.includes('restaurant')) notFound();
  if (!can(ctx, 'inventory.read') && !can(ctx, 'inventory.waste')) notFound();

  const days = PERIODS.find((d) => String(d) === searchParams.days) ?? 7;
  const to = new Date(Date.now() + 60_000);
  const from = new Date(to.getTime() - days * 86_400_000);

  let data; let items;
  try {
    data = await getWastage(ctx, from, to);
    const supabase = createSupabaseServerClient();
    const { data: rows } = await supabase.from('inventory_items').select('id, name, unit, avg_cost_cents')
      .eq('organization_id', ctx.organizationId).eq('is_active', true).order('name');
    items = (rows ?? []).map((i) => ({ id: i.id, name: i.name, unit: i.unit, avgCostCents: Number(i.avg_cost_cents) }));
  } catch (error) {
    return <DataUnavailable error={error} />;
  }

  return (
    <div className="space-y-4">
      <PageHeader title="الهالك" description="سجّل خسائر المطبخ والمخزن بالسبب والملاحظة. الكمية تخرج من رصيد المكان وتُحسب بتكلفتها." />
      <WastageBoard
        scope={{ organizationSlug: ctx.organizationSlug, branchSlug: ctx.branchSlug }}
        basePath={`/${ctx.organizationSlug}/${ctx.branchSlug}/inventory/wastage`}
        currency={ctx.currency}
        days={days}
        entries={data.entries}
        summary={data.summary}
        items={items}
        canRecord={can(ctx, 'inventory.waste')}
      />
    </div>
  );
}
