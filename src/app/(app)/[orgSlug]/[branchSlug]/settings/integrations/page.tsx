import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { listIntegrations } from '@/modules/restaurant/integrations/service';
import { clientEnv } from '@/lib/env';
import { DataUnavailable } from '@/components/patterns/data-unavailable';
import { PageHeader } from '@/components/patterns/page-header';
import { IntegrationsView } from './integrations-view';

export const metadata = { title: 'تكامل الطلبات' };
export const dynamic = 'force-dynamic';

export default async function IntegrationsPage({ params }: { params: { orgSlug: string; branchSlug: string } }) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'restaurant.integration.manage')) notFound();
  if (!ctx.enabledModules.includes('restaurant')) notFound();

  let integrations;
  try { integrations = await listIntegrations(ctx); } catch (error) { return <DataUnavailable error={error} />; }

  return (
    <div className="space-y-4">
      <PageHeader title="تكامل الطلبات" description="مفاتيح API لاستقبال طلبات الموقع والتطبيق ومنصات التوصيل مباشرة على شاشة المطبخ." />
      <IntegrationsView
        scope={{ organizationSlug: ctx.organizationSlug, branchSlug: ctx.branchSlug }}
        appUrl={clientEnv.NEXT_PUBLIC_APP_URL.replace(/\/$/, '')}
        integrations={integrations}
      />
    </div>
  );
}
