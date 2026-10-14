import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { getPaymentSettings } from '@/modules/restaurant/payments/service';
import { PageHeader } from '@/components/patterns/page-header';
import { DataUnavailable } from '@/components/patterns/data-unavailable';
import { PaymentsForm } from './form';

export const metadata = { title: 'المدفوعات' };
export const dynamic = 'force-dynamic';

export default async function PaymentsSettingsPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  // 404 rather than 403, as everywhere else in settings.
  if (!can(ctx, 'settings.manage')) notFound();
  if (!ctx.enabledModules.includes('restaurant')) notFound();

  let settings: Awaited<ReturnType<typeof getPaymentSettings>>;
  try {
    settings = await getPaymentSettings(ctx);
  } catch (error) {
    return (
      <div className="space-y-5">
        <PageHeader title="المدفوعات" />
        <DataUnavailable error={error} />
      </div>
    );
  }
  return <PaymentsForm
      scope={{ organizationSlug: ctx.organizationSlug, branchSlug: ctx.branchSlug }}
      settings={settings}
    />;
}
