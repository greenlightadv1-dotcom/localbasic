import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { getOnlineSettings } from '@/modules/restaurant/online/settings';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { OnlineOrderingForm } from './form';

export const metadata = { title: 'الطلب أونلاين' };
export const dynamic = 'force-dynamic';

export default async function OnlineOrderingSettingsPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; branchSlug: string };
  searchParams: { saved?: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  // 404 rather than 403, as everywhere else: a member without the permission
  // learns nothing about the screen.
  if (!can(ctx, 'settings.manage')) notFound();
  if (!ctx.enabledModules.includes('restaurant')) notFound();

  const settings = await getOnlineSettings(ctx);
  const inherited = Object.values(settings.overriddenAtBranch).every((v) => !v);

  return (
    <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
      <Card>
        <CardHeader className="flex flex-wrap items-center gap-2">
          <CardTitle>الطلب أونلاين</CardTitle>
          {settings.enabled ? (
            <Badge tone="success">مفعّل</Badge>
          ) : (
            <Badge tone="warn">موقوف</Badge>
          )}
          {inherited ? <Badge tone="info">يتبع إعداد كل الفروع</Badge> : null}
        </CardHeader>
        <CardBody>
          {searchParams.saved === '1' ? (
            <p
              data-testid="settings-saved"
              className="mb-4 rounded border border-success/30 bg-success/10 px-4 py-3 text-sm font-semibold text-success"
            >
              تم حفظ الإعدادات.
            </p>
          ) : null}
          <OnlineOrderingForm
            orgSlug={ctx.organizationSlug}
            branchSlug={ctx.branchSlug}
            branchName={ctx.branchName}
            currency={ctx.currency}
            settings={settings}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>ماذا يرى العميل الآن</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3 text-sm">
          {!settings.enabled ? (
            <p className="text-muted">
              صفحة الطلب مغلقة تمامًا. لا يمكن لأي عميل إرسال طلب، حتى لو كان يملك الرابط.
            </p>
          ) : (
            <>
              <p className="text-muted">
                صفحة الطلب متاحة، ويستطيع العميل اختيار:
              </p>
              <ul className="space-y-1.5">
                <li className="flex items-center gap-2">
                  <span className={settings.pickupEnabled ? 'text-success' : 'text-danger'}>
                    {settings.pickupEnabled ? '✓' : '✕'}
                  </span>
                  <span className="text-fg">الاستلام من المطعم</span>
                </li>
                <li className="flex items-center gap-2">
                  <span className={settings.deliveryEnabled ? 'text-success' : 'text-danger'}>
                    {settings.deliveryEnabled ? '✓' : '✕'}
                  </span>
                  <span className="text-fg">
                    التوصيل
                    {settings.deliveryEnabled ? (
                      <span className="text-muted">
                        {' '}— {(settings.deliveryFeeCents / 100).toLocaleString('ar-EG')} {ctx.currency}
                      </span>
                    ) : null}
                  </span>
                </li>
              </ul>
              {!settings.pickupEnabled && !settings.deliveryEnabled ? (
                <p className="rounded border border-warn/40 bg-warn/10 px-3 py-2 text-warn">
                  لا توجد طريقة استلام مفعّلة، فلن يتمكن أي عميل من إتمام طلب.
                </p>
              ) : null}
            </>
          )}
          <p className="border-t border-line pt-3 text-xs leading-relaxed text-muted">
            تُطبَّق هذه الإعدادات على الخادم عند كل طلب، وليس في المتصفح فقط.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
