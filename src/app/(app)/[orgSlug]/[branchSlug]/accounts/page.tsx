import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { listAccounts } from '@/modules/restaurant/crm/service';
import { DataUnavailable } from '@/components/patterns/data-unavailable';
import { PageHeader } from '@/components/patterns/page-header';
import { AccountsView } from './accounts-view';

export const metadata = { title: 'حسابات العملاء الآجلة' };
export const dynamic = 'force-dynamic';

export default async function AccountsPage({ params }: { params: { orgSlug: string; branchSlug: string } }) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'restaurant.account.manage')) notFound();

  let accounts;
  try { accounts = await listAccounts(ctx); } catch (error) { return <DataUnavailable error={error} />; }

  return (
    <div className="space-y-4">
      <PageHeader title="حسابات العملاء الآجلة" description="حسابات الشركات وكبار العملاء: حد الائتمان، الرصيد المفتوح، المتأخرات وكشف الحساب." />
      <AccountsView
        scope={{ organizationSlug: ctx.organizationSlug, branchSlug: ctx.branchSlug }}
        basePath={`/${ctx.organizationSlug}/${ctx.branchSlug}/accounts`}
        currency={ctx.currency}
        accounts={accounts}
      />
    </div>
  );
}
