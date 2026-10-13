import { notFound } from 'next/navigation';
import Link from 'next/link';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { getBranding } from '@/modules/core/branding/service';
import { getWebsiteSettings } from '@/modules/restaurant/website/settings';
import { listDomains } from '@/modules/restaurant/website/domains';
import { DOMAIN_STATUS_LABELS } from '@/modules/restaurant/website/domains-shared';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { clientEnv } from '@/lib/env';
import { Customizer } from './customizer';
import { WebsiteContentSection } from './website-content';

export const metadata = { title: 'الهوية والثيم' };
export const dynamic = 'force-dynamic';

/**
 * Brand & Theme.
 *
 * The one place a store sets how its customer-facing menu looks: name, logo,
 * description, brand colors (on plans that include them), opening hours, and
 * the custom domain. It replaced the section-by-section site editor — there is
 * no layout to arrange any more, because the menu is a fixed, mobile-first food
 * ordering page that takes its look from this page.
 */
export default async function BrandThemePage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; branchSlug: string };
  searchParams: { saved?: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'branding.manage') && !can(ctx, 'settings.manage')) notFound();

  const canBrand = can(ctx, 'branding.manage');
  const canSettings = can(ctx, 'settings.manage') && ctx.enabledModules.includes('restaurant');

  const [branding, websiteSettings, domains] = await Promise.all([
    getBranding(ctx),
    canSettings ? getWebsiteSettings(ctx) : Promise.resolve(null),
    canSettings ? listDomains(ctx).catch(() => []) : Promise.resolve([]),
  ]);

  const menuUrl = `${clientEnv.NEXT_PUBLIC_APP_URL}/r/${ctx.organizationSlug}`;
  const base = `/${ctx.organizationSlug}/${ctx.branchSlug}`;
  const primaryDomain = domains.find((d) => d.isPrimary) ?? domains[0];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold text-fg">الهوية والثيم</h1>
        <p className="text-sm text-muted">
          اسم متجرك وشعاره ووصفه وألوانه من هنا، وتُطبَّق مباشرة على منيو الطلب أونلاين ومنيو QR.
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
          customColors={branding.customColors}
          description={websiteSettings?.tagline ?? ''}
          initial={{
            displayName: branding.displayName,
            logoUrl: branding.logoUrl,
            primaryColor: branding.storedPrimaryColor,
            secondaryColor: branding.storedSecondaryColor,
            phone: branding.phone ?? '',
            whatsapp: branding.whatsapp ?? '',
            email: branding.email ?? '',
          }}
        />
      ) : null}

      {canSettings && websiteSettings ? (
        <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
          <Card>
            <CardHeader className="flex flex-wrap items-center gap-2">
              <CardTitle>الوصف والمواعيد</CardTitle>
              {websiteSettings.enabled ? (
                <Badge tone="success">المنيو منشور</Badge>
              ) : (
                <Badge tone="warn">المنيو غير منشور</Badge>
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

          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>رابط المنيو</CardTitle>
              </CardHeader>
              <CardBody className="space-y-3 text-sm">
                <p className="break-all rounded bg-surface px-3 py-2 font-mono text-xs text-fg" dir="ltr">
                  {menuUrl}
                </p>
                {websiteSettings.enabled ? (
                  <Link
                    href={`/r/${ctx.organizationSlug}`}
                    className="inline-flex h-11 w-full items-center justify-center rounded-lg bg-primary px-5 text-sm font-semibold text-primary-fg hover:bg-primary/90"
                  >
                    افتح المنيو
                  </Link>
                ) : (
                  <p className="text-muted">المنيو غير منشور، ولن يفتح هذا الرابط لأي زائر.</p>
                )}
                <p className="border-t border-line pt-3 text-xs leading-relaxed text-muted">
                  يظهر زر الطلب في الفروع التي فعّلت الطلب أونلاين من صفحة{' '}
                  <Link href={`${base}/settings/online-ordering`} className="font-semibold text-primary hover:underline">
                    الطلب أونلاين
                  </Link>
                  . وأي فرع آخر يعرض المنيو للقراءة فقط.
                </p>
              </CardBody>
            </Card>

            <Card>
              <CardHeader className="flex flex-wrap items-center gap-2">
                <CardTitle>النطاق المخصص</CardTitle>
                {primaryDomain ? (
                  <Badge tone={primaryDomain.status === 'active' ? 'success' : 'warn'}>
                    {DOMAIN_STATUS_LABELS[primaryDomain.status]}
                  </Badge>
                ) : null}
              </CardHeader>
              <CardBody className="space-y-3 text-sm">
                {primaryDomain ? (
                  <p className="break-all rounded bg-surface px-3 py-2 font-mono text-xs text-fg" dir="ltr">
                    {primaryDomain.hostname}
                  </p>
                ) : (
                  <p className="text-muted">
                    اربط نطاقك الخاص (مثل <span dir="ltr">menu.mystore.com</span>) ليفتح منيوك على
                    عنوانك أنت.
                  </p>
                )}
                <Link
                  href={`${base}/settings/website/domains`}
                  className="inline-flex h-11 w-full items-center justify-center rounded-lg border border-line bg-elevated px-5 text-sm font-semibold text-fg hover:bg-surface"
                >
                  {primaryDomain ? 'إدارة النطاق وسجلات DNS' : 'ربط نطاق (CNAME / DNS)'}
                </Link>
              </CardBody>
            </Card>
          </div>
        </div>
      ) : null}
    </div>
  );
}
