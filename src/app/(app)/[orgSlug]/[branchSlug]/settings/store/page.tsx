import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { getStoreSettings } from '@/modules/retail/store/settings';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StoreSettingsForm } from './form';

export const metadata = { title: 'المتجر الإلكتروني' };
export const dynamic = 'force-dynamic';

export default async function StoreSettingsPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  // 404 rather than 403, as everywhere else.
  if (!can(ctx, 'settings.manage')) notFound();
  if (!ctx.enabledModules.includes('retail')) notFound();

  const settings = await getStoreSettings(ctx);
  const storeUrl = `/shop/${ctx.organizationSlug}/${ctx.branchSlug}`;

  return (
    <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
      <Card>
        <CardHeader className="flex flex-wrap items-center gap-2">
          <CardTitle>المتجر الإلكتروني</CardTitle>
          {settings.enabled ? <Badge tone="success">مفتوح</Badge> : <Badge tone="warn">مغلق</Badge>}
        </CardHeader>
        <CardBody>
          <StoreSettingsForm
            orgSlug={ctx.organizationSlug}
            branchSlug={ctx.branchSlug}
            settings={settings}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>رابط المتجر</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3 text-sm">
          <p className="text-muted">
            هذا هو الرابط الذي يشاركه العملاء. لا يعمل إلا والمتجر مفتوح.
          </p>
          <p className="break-all rounded bg-surface px-3 py-2 font-mono text-xs text-fg" dir="ltr">
            {storeUrl}
          </p>
          <p className="text-xs text-muted">
            المخزون المعروض في المتجر هو نفسه مخزون نقطة البيع، فلا يمكن بيع القطعة
            الأخيرة مرتين.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
