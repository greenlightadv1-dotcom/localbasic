import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { listCashierZones } from '@/modules/restaurant/approvals/service';
import { listSections } from '@/modules/restaurant/tables/service';
import { DataUnavailable } from '@/components/patterns/data-unavailable';
import { CashierZonesForm } from './form';

export const metadata = { title: 'مناطق الكاشير' };
export const dynamic = 'force-dynamic';

export default async function CashierZonesPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'member.manage')) notFound();
  if (!ctx.enabledModules.includes('restaurant')) notFound();

  let data: [Awaited<ReturnType<typeof listCashierZones>>, Awaited<ReturnType<typeof listSections>>];
  try {
    data = await Promise.all([listCashierZones(ctx), listSections(ctx)]);
  } catch (error) {
    return <DataUnavailable error={error} />;
  }
  const [cashiers, sections] = data;

  return (
    <CashierZonesForm
      scope={{ organizationSlug: ctx.organizationSlug, branchSlug: ctx.branchSlug }}
      cashiers={cashiers}
      sections={sections.filter((s) => s.is_active).map((s) => ({ id: s.id, name: s.name }))}
    />
  );
}
