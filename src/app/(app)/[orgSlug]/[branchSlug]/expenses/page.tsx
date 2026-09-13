import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/patterns/page-header';
import { ExpensesManager } from './expenses-manager';

export const metadata = { title: 'المصروفات' };
export const dynamic = 'force-dynamic';

export default async function ExpensesPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'treasury.read')) notFound();

  const supabase = createSupabaseServerClient();
  const { data: expenses } = await supabase
    .from('treasury_transactions')
    .select('id, amount_cents, category, reason, occurred_at, created_by')
    .eq('organization_id', ctx.organizationId)
    .eq('branch_id', ctx.branchId)
    .eq('direction', 'out')
    .order('occurred_at', { ascending: false })
    .limit(100);

  return (
    <div className="space-y-5">
      <PageHeader
        title="المصروفات"
        description={`مصروفات ${ctx.branchName}. كل مصروف يُسجَّل في دفتر الخزينة ولا يمكن تعديله.`}
      />
      <ExpensesManager
        expenses={expenses ?? []}
        currency={ctx.currency}
        canRecord={can(ctx, 'treasury.create')}
        organizationSlug={ctx.organizationSlug}
        branchSlug={ctx.branchSlug}
      />
    </div>
  );
}
