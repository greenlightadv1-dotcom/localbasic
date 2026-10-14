import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { getReceiptSettings } from '@/modules/restaurant/receipt/service';
import { getBranding } from '@/modules/core/branding/service';
import { DataUnavailable } from '@/components/patterns/data-unavailable';
import { ReceiptSettingsForm } from './form';

export const metadata = { title: 'بيانات الإيصال' };
export const dynamic = 'force-dynamic';

export default async function ReceiptSettingsPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  // 404 rather than 403, as everywhere else in settings.
  if (!can(ctx, 'settings.manage')) notFound();
  if (!ctx.enabledModules.includes('restaurant')) notFound();

  let settings: Awaited<ReturnType<typeof getReceiptSettings>>;
  try {
    settings = await getReceiptSettings(ctx);
  } catch (error) {
    return <DataUnavailable error={error} />;
  }
  const branding = await getBranding(ctx);

  return (
    <ReceiptSettingsForm
      scope={{ organizationSlug: ctx.organizationSlug, branchSlug: ctx.branchSlug }}
      settings={settings}
      businessName={branding.displayName}
      fallbackPhone={branding.phone}
      currency={ctx.currency}
      whiteLabel={branding.whiteLabel}
    />
  );
}
