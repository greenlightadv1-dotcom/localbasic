import { notFound } from 'next/navigation';
import Link from 'next/link';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { getBranding } from '@/modules/core/branding/service';
import { getWebsiteSettings } from '@/modules/restaurant/website/settings';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { clientEnv } from '@/lib/env';
import { Customizer } from './customizer';
import { WebsiteContentSection } from './website-content';

export const metadata = { title: 'الموقع' };
export const dynamic = 'force-dynamic';

/**
 * The website builder: one dashboard for everything a restaurant's public
 * presence is made of — brand identity (logo/colors/contact) and the public
 * website's own content (tagline/about/cover/hours/publish), with a direct
 * link into the section editor. This used to be several separate settings
 * screens; they write to different tables still — this is a navigation and
 * layout consolidation, not a schema merge.
 */
export default async function BrandingPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; branchSlug: string };
  searchParams: { saved?: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'branding.manage') && !can(ctx, 'settings.manage')) notFound();

  const canBrand = can(ctx, 'branding.manage');
  const canWebsite = can(ctx, 'settings.manage') && ctx.enabledModules.includes('restaurant');

  const [branding, websiteSettings] = await Promise.all([
    getBranding(ctx),
    canWebsite ? getWebsiteSettings(ctx) : Promise.resolve(null),
  ]);

  const siteUrl = `${clientEnv.NEXT_PUBLIC_APP_URL}/r/${ctx.organizationSlug}`;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold text-fg">الموقع</h1>
        <p className="text-sm text-muted">
          الشعار والألوان ومحتوى الموقع كلها من هنا، وتُطبَّق مباشرة على صفحة الطلب والموقع الإلكتروني.
        </p>
      </div>

      {searchParams.saved === '1' ? (
        <p
          data-testid="website-saved"
          className="rounded-lg border border-success/30 bg-success/10 px-4 py-3 text-sm font-semibold text-success"
        >
          تم حفظ الإعدادات.
        </p>
      ) : null}

      {canBrand ? (
        <Customizer
          scope={{ organizationSlug: params.orgSlug, branchSlug: params.branchSlug }}
          organizationId={ctx.organizationId}
          whiteLabel={branding.whiteLabel}
          initial={{
            displayName: branding.displayName,
            logoUrl: branding.logoUrl,
            primaryColor: branding.primaryColor,
            secondaryColor: branding.secondaryColor,
            phone: branding.phone ?? '',
            whatsapp: branding.whatsapp ?? '',
            email: branding.email ?? '',
          }}
        />
      ) : null}

      {canWebsite && websiteSettings ? (
        <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
          <Card>
            <CardHeader className="flex flex-wrap items-center gap-2">
              <CardTitle>محتوى الموقع الإلكتروني</CardTitle>
              {websiteSettings.enabled ? (
                <Badge tone="success">منشور</Badge>
              ) : (
                <Badge tone="warn">غير منشور</Badge>
              )}
            </CardHeader>
            <CardBody>
              <WebsiteContentSection
                organizationId={ctx.organizationId}
                orgSlug={ctx.organizationSlug}
                branchSlug={ctx.branchSlug}
                settings={websiteSettings}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>عنوان موقعك</CardTitle>
            </CardHeader>
            <CardBody className="space-y-3 text-sm">
              <p className="break-all rounded bg-surface px-3 py-2 font-mono text-xs text-fg" dir="ltr">
                {siteUrl}
              </p>
              <Link
                href={`/${ctx.organizationSlug}/${ctx.branchSlug}/settings/website/builder`}
                className="inline-flex h-11 w-full items-center justify-center rounded-lg border border-line bg-elevated px-5 text-sm font-semibold text-fg hover:bg-surface"
              >
                افتح محرّر الموقع
              </Link>
              {websiteSettings.enabled ? (
                <Link
                  href={`/r/${ctx.organizationSlug}`}
                  className="inline-flex h-11 items-center justify-center rounded-lg bg-primary px-5 text-sm font-semibold text-primary-fg hover:bg-primary/90"
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
      ) : null}
    </div>
  );
}
