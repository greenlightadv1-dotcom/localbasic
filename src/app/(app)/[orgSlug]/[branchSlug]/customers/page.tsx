import { notFound } from 'next/navigation';
import { Users } from 'lucide-react';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { toDataUnavailable } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { listCustomerDirectory } from '@/modules/restaurant/customers/service';
import { PageHeader } from '@/components/patterns/page-header';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/patterns/states';
import { DataUnavailable } from '@/components/patterns/data-unavailable';
import { CustomerDirectory } from './directory';

export const metadata = { title: 'العملاء' };
export const dynamic = 'force-dynamic';

export default async function CustomersPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'customer.read')) notFound();

  // Restaurants: every guest who ever ordered, grouped by phone, with their
  // spend, points and bound devices.
  if (ctx.enabledModules.includes('restaurant')) {
    let directory: Awaited<ReturnType<typeof listCustomerDirectory>>;
    try {
      directory = await listCustomerDirectory(ctx);
    } catch (error) {
      return (
        <div className="space-y-5">
          <PageHeader title="العملاء" />
          <DataUnavailable error={error} />
        </div>
      );
    }
    const { rows, truncated } = directory;
    return (
      <div className="space-y-5">
        <PageHeader title="العملاء" description="كل من طلب من المتجر أو الكاشير، مجمَّعين برقم الهاتف" />
        <CustomerDirectory
          rows={rows}
          truncated={truncated}
          currency={ctx.currency}
          orgSlug={ctx.organizationSlug}
          storeName={ctx.organizationName}
          canManage={can(ctx, 'customer.update')}
          scope={{ organizationSlug: ctx.organizationSlug, branchSlug: ctx.branchSlug }}
        />
      </div>
    );
  }

  // Other verticals keep the plain list of registered customers.
  const supabase = createSupabaseServerClient();
  const { data: customers, error: customersError } = await supabase
    .from('customers')
    .select('id, name, phone, email, created_at')
    .eq('organization_id', ctx.organizationId)
    .is('deleted_at', null)
    .order('name')
    .limit(200);

  if (customersError) {
    return (
      <div className="space-y-5">
        <PageHeader title="العملاء" />
        <DataUnavailable error={toDataUnavailable(customersError, 'customers list')} />
      </div>
    );
  }
  const rows = customers ?? [];

  return (
    <div className="space-y-5">
      <PageHeader title="العملاء" description={`${rows.length} عميل مسجّل`} />
      <Card>
        {rows.length === 0 ? (
          <EmptyState
            icon={Users}
            title="لا يوجد عملاء"
            description="يُضاف العميل عند ربطه بطلب من شاشة الكاشير."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">قائمة العملاء</caption>
              <thead>
                <tr className="border-b border-line text-xs text-muted">
                  <th scope="col" className="p-3 text-start font-medium">الاسم</th>
                  <th scope="col" className="p-3 text-start font-medium">الهاتف</th>
                  <th scope="col" className="p-3 text-start font-medium">البريد</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((customer) => (
                  <tr key={customer.id} className="border-b border-line last:border-0">
                    <td className="p-3 font-medium">{customer.name}</td>
                    <td className="p-3 lb-numeric text-muted">{customer.phone ?? '—'}</td>
                    <td className="p-3 text-muted" dir="ltr">{customer.email ?? '—'}</td>
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
