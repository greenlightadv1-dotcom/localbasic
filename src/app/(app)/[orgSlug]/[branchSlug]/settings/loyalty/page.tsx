import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { getLoyaltySettings } from '@/modules/restaurant/loyalty/service';
import { LoyaltyForm } from './form';

export const metadata = { title: 'برنامج المكافآت' };
export const dynamic = 'force-dynamic';

export default async function LoyaltySettingsPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'settings.manage')) notFound();
  if (!ctx.enabledModules.includes('restaurant')) notFound();

  const settings = await getLoyaltySettings(ctx);
  return (
    <LoyaltyForm
      scope={{ organizationSlug: ctx.organizationSlug, branchSlug: ctx.branchSlug }}
      currency={ctx.currency}
      settings={settings}
    />
  );
}
