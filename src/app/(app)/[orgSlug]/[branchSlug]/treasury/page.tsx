import { notFound } from 'next/navigation';
import { Wallet } from 'lucide-react';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/patterns/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Money } from '@/components/patterns/money';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/patterns/states';

export const metadata = { title: 'الخزينة' };
export const dynamic = 'force-dynamic';

const CATEGORY_LABELS: Record<string, string> = {
  sale: 'مبيعات',
  refund: 'مرتجع',
  expense: 'مصروف',
  supplies: 'مستلزمات',
  maintenance: 'صيانة',
  utilities: 'مرافق',
  salary: 'رواتب',
  rent: 'إيجار',
  purchase: 'مشتريات',
  withdrawal: 'سحب',
  deposit: 'إيداع',
  transfer: 'تحويل',
  adjustment: 'تسوية',
  other: 'أخرى',
};

/**
 * The branch treasury.
 *
 * The balance shown is derived by summing the ledger, never read from a stored
 * "current balance" column — there isn't one. Every row is append-only.
 */
export default async function TreasuryPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'treasury.read')) notFound();

  const supabase = createSupabaseServerClient();

  const [{ data: accounts }, { data: ledger }] = await Promise.all([
    supabase
      .from('treasury_accounts')
      .select('id, name, type, currency, is_default')
      .eq('organization_id', ctx.organizationId)
      .eq('branch_id', ctx.branchId)
      .eq('is_active', true),
    supabase
      .from('treasury_transactions')
      .select('id, direction, amount_cents, category, reason, occurred_at, account_id')
      .eq('organization_id', ctx.organizationId)
      .eq('branch_id', ctx.branchId)
      .order('occurred_at', { ascending: false })
      .limit(150),
  ]);

  const rows = ledger ?? [];
  const balances = new Map<string, number>();
  for (const row of rows) {
    const current = balances.get(row.account_id) ?? 0;
    balances.set(row.account_id, current + (row.direction === 'in' ? row.amount_cents : -row.amount_cents));
  }

  const totalIn = rows.filter((r) => r.direction === 'in').reduce((s, r) => s + r.amount_cents, 0);
  const totalOut = rows.filter((r) => r.direction === 'out').reduce((s, r) => s + r.amount_cents, 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title="الخزينة"
        description={`${ctx.branchName} — الرصيد محسوب من دفتر الحركة، وكل حركة غير قابلة للتعديل.`}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        {(accounts ?? []).map((account) => (
          <Card key={account.id}>
            <CardBody className="space-y-1">
              <p className="flex items-center gap-2 text-xs font-medium text-muted">
                {account.name}
                {account.is_default && <Badge tone="info">افتراضي</Badge>}
              </p>
              <p className="text-xl font-bold">
                <Money cents={balances.get(account.id) ?? 0} currency={account.currency} />
              </p>
            </CardBody>
          </Card>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <CardBody className="space-y-1">
            <p className="text-xs font-medium text-muted">إجمالي الوارد (آخر ١٥٠ حركة)</p>
            <p className="text-xl font-bold text-success">
              <Money cents={totalIn} currency={ctx.currency} />
            </p>
          </CardBody>
        </Card>
        <Card>
          <CardBody className="space-y-1">
            <p className="text-xs font-medium text-muted">إجمالي الصادر</p>
            <p className="text-xl font-bold text-danger">
              <Money cents={totalOut} currency={ctx.currency} />
            </p>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>دفتر الحركة</CardTitle>
        </CardHeader>
        {rows.length === 0 ? (
          <EmptyState
            icon={Wallet}
            title="لا توجد حركات"
            description="ستظهر هنا كل المدفوعات والمصروفات."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">حركات الخزينة</caption>
              <thead>
                <tr className="border-b border-line text-xs text-muted">
                  <th scope="col" className="p-3 text-start font-medium">التاريخ</th>
                  <th scope="col" className="p-3 text-start font-medium">النوع</th>
                  <th scope="col" className="p-3 text-start font-medium">البيان</th>
                  <th scope="col" className="p-3 text-start font-medium">المبلغ</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-line last:border-0">
                    <td className="p-3 lb-numeric text-muted">
                      {new Date(row.occurred_at).toLocaleString('ar-EG', {
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td className="p-3">{CATEGORY_LABELS[row.category] ?? row.category}</td>
                    <td className="p-3 text-muted">{row.reason ?? '—'}</td>
                    <td className="p-3">
                      <Money
                        cents={row.amount_cents}
                        currency={ctx.currency}
                        tone={row.direction === 'in' ? 'positive' : 'negative'}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
