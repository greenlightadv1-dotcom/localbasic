import { notFound } from 'next/navigation';
import Link from 'next/link';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { getBranding } from '@/modules/core/branding/service';
import { Customizer } from './customizer';

export const metadata = { title: 'الهوية' };
export const dynamic = 'force-dynamic';

export default async function BrandingPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'branding.manage')) notFound();

  const branding = await getBranding(ctx);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-fg">هوية المطعم</h1>
          <p className="text-sm text-muted">
            الشعار والألوان تُطبَّق مباشرة على صفحة الطلب والموقع الإلكتروني.
          </p>
        </div>
        <Link
          href={`/${params.orgSlug}/${params.branchSlug}/settings/sites`}
          className="text-sm font-semibold text-primary hover:underline"
        >
          محتوى الصفحات (محرر الأقسام) ←
        </Link>
      </div>

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
    </div>
  );
}
