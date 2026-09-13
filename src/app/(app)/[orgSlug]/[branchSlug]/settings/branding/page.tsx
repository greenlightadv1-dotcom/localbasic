import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { getBranding } from '@/modules/core/branding/service';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Logo, PoweredBy } from '@/components/brand/logo';

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
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>هوية المطعم</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted">الاسم المعروض</dt>
              <dd className="font-medium">{branding.displayName}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted">اللون الأساسي</dt>
              <dd className="flex items-center gap-2">
                <span
                  className="h-5 w-5 rounded border border-line"
                  style={{ background: branding.primaryColor }}
                  aria-hidden="true"
                />
                <span className="lb-numeric">{branding.primaryColor}</span>
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted">اللون الثانوي</dt>
              <dd className="flex items-center gap-2">
                <span
                  className="h-5 w-5 rounded border border-line"
                  style={{ background: branding.secondaryColor }}
                  aria-hidden="true"
                />
                <span className="lb-numeric">{branding.secondaryColor}</span>
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">الهاتف</dt>
              <dd className="lb-numeric">{branding.phone ?? '—'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">واتساب</dt>
              <dd className="lb-numeric">{branding.whatsapp ?? '—'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">العلامة البيضاء</dt>
              <dd>
                <Badge tone={branding.whiteLabel ? 'success' : 'neutral'}>
                  {branding.whiteLabel ? 'مفعّلة' : 'غير مفعّلة'}
                </Badge>
              </dd>
            </div>
          </dl>
          <p className="text-xs text-muted">
            الألوان تُطبَّق مباشرة على كل الشاشات وصفحة الـQR للعملاء. إزالة شعار LocalBasic
            متاحة في الباقات الأعلى فقط.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>معاينة</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="rounded-lg border border-line p-6 text-center">
            <Logo className="mx-auto h-10" />
            <p className="mt-4 text-lg font-bold">{branding.displayName}</p>
            <p className="text-sm text-muted">{ctx.branchName}</p>
            <div className="mt-4 flex justify-center gap-2">
              <span className="rounded bg-primary px-3 py-1.5 text-sm font-semibold text-primary-fg">
                زر أساسي
              </span>
              <span className="rounded bg-accent px-3 py-1.5 text-sm font-semibold text-white">
                زر ثانوي
              </span>
            </div>
            {!branding.whiteLabel && <PoweredBy className="mt-6" />}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
