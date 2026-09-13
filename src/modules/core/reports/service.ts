import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { toAppError } from '@/lib/errors';
import { can, type TenantContext } from '@/modules/core/tenancy/context';

export type DashboardSummary = {
  salesTodayCents: number;
  invoicesToday: number;
  treasuryBalanceCents: number;
  customerCount: number;
};

/**
 * Dashboard figures for the current branch.
 *
 * Every query is scoped to ctx.organizationId and ctx.branchId in the service
 * AND constrained again by RLS, so a bug here cannot widen the result set past
 * what the user may see. Sections the user lacks permission for are skipped
 * rather than computed and hidden.
 */
export async function getDashboardSummary(ctx: TenantContext): Promise<DashboardSummary> {
  const supabase = createSupabaseServerClient();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const since = startOfDay.toISOString();

  const summary: DashboardSummary = {
    salesTodayCents: 0,
    invoicesToday: 0,
    treasuryBalanceCents: 0,
    customerCount: 0,
  };

  if (can(ctx, 'invoice.read')) {
    const { data, error } = await supabase
      .from('invoices')
      .select('total_cents')
      .eq('organization_id', ctx.organizationId)
      .eq('branch_id', ctx.branchId)
      .neq('status', 'draft')
      .is('voided_at', null)
      .gte('created_at', since);
    if (error) throw toAppError(error, 'dashboard invoices');
    summary.invoicesToday = data?.length ?? 0;
    summary.salesTodayCents = (data ?? []).reduce((sum, row) => sum + row.total_cents, 0);
  }

  if (can(ctx, 'treasury.read')) {
    const { data, error } = await supabase
      .from('treasury_transactions')
      .select('direction, amount_cents')
      .eq('organization_id', ctx.organizationId)
      .eq('branch_id', ctx.branchId);
    if (error) throw toAppError(error, 'dashboard treasury');
    summary.treasuryBalanceCents = (data ?? []).reduce(
      (sum, row) => sum + (row.direction === 'in' ? row.amount_cents : -row.amount_cents),
      0,
    );
  }

  if (can(ctx, 'customer.read')) {
    const { count, error } = await supabase
      .from('customers')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', ctx.organizationId)
      .is('deleted_at', null);
    if (error) throw toAppError(error, 'dashboard customers');
    summary.customerCount = count ?? 0;
  }

  return summary;
}
