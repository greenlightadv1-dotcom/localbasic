import { notFound } from 'next/navigation';
import Link from 'next/link';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { getWebsiteSettings } from '@/modules/restaurant/website/settings';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { clientEnv } from '@/lib/env';
import { WebsiteForm } from './form';

export const metadata = { title: 'الموقع الإلكتروني' };
export const dynamic = 'force-dynamic';

export default async function WebsiteSettingsPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; branchSlug: string };
  searchParams: { saved?: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'settings.manage')) notFound();
  if (!ctx.enabledModules.includes('restaurant')) notFound();

  const settings = await getWebsiteSettings(ctx);
  const url = `${clientEnv.NEXT_PUBLIC_APP_URL}/r/${ctx.organizationSlug}`;

  return (
    <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
      <Card>
        <CardHeader className="flex flex-wrap items-center gap-2">
          <CardTitle>الموقع الإلكتروني</CardTitle>
          {settings.enabled ? <Badge tone="success">منشور</Badge> : <Badge tone="warn">غير منشور</Badge>}
        </CardHeader>
        <CardBody>
          {searchParams.saved === '1' ? (
            <p
              data-testid="website-saved"
              className="mb-4 rounded border border-success/30 bg-success/10 px-4 py-3 text-sm font-semibold text-success"
            >
              تم حفظ الإعدادات.
            </p>
          ) : null}
          <WebsiteForm
            orgSlug={ctx.organizationSlug}
            branchSlug={ctx.branchSlug}
            settings={settings}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>عنوان موقعك</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3 text-sm">
          <p className="break-all rounded bg-surface px-3 py-2 font-mono text-xs text-fg" dir="ltr">
            {url}
          </p>
          <Link
            href={`/${ctx.organizationSlug}/${ctx.branchSlug}/settings/website/builder`}
            className="inline-flex h-11 w-full items-center justify-center rounded border border-line bg-elevated px-5 text-sm font-semibold text-fg hover:bg-surface"
          >
            افتح محرّر الموقع
          </Link>
          {settings.enabled ? (
            <Link
              href={`/r/${ctx.organizationSlug}`}
              className="inline-flex h-11 items-center justify-center rounded bg-primary px-5 text-sm font-semibold text-primary-fg hover:bg-primary/90"
            >
              افتح الموقع
            </Link>
          ) : (
            <p className="text-muted">الموقع غير منشور، ولن يفتح هذا الرابط لأي زائر.</p>
          )}
          <p className="border-t border-line pt-3 text-xs leading-relaxed text-muted">
            يعرض الموقع منيو كل فرع وبياناته، ويظهر زر الطلب فقط في الفروع التي فعّلت
            الطلب أونلاين من صفحة{' '}
            <Link
              href={`/${ctx.organizationSlug}/${ctx.branchSlug}/settings/online-ordering`}
              className="font-semibold text-primary hover:underline"
            >
              الطلب أونلاين
            </Link>
            .
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
