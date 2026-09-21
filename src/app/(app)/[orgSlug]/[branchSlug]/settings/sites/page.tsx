import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Globe } from 'lucide-react';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { PageHeader } from '@/components/patterns/page-header';
import { Card, CardBody } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/patterns/states';
import { listSites } from '@/modules/sites/service';
import { CreateSiteForm } from './create-site-form';

export const metadata = { title: 'المواقع الإلكترونية' };
export const dynamic = 'force-dynamic';

export default async function SitesPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  // 404 rather than 403, the same answer the rest of the platform gives, so a
  // URL cannot be probed for whether a feature exists behind it.
  if (!can(ctx, 'site.read')) notFound();

  const sites = await listSites(ctx);
  const base = `/${ctx.organizationSlug}/${ctx.branchSlug}/settings/sites`;
  const canManage = can(ctx, 'site.manage');

  return (
    <div className="space-y-5">
      <PageHeader
        title="المواقع الإلكترونية"
        description={`مواقع ${ctx.organizationName}. لكل موقع صفحاته وأقسامه وإعداداته.`}
      />

      {sites.length === 0 ? (
        <Card>
          <CardBody>
            <EmptyState
              icon={Globe}
              title="لا توجد مواقع بعد"
              description={
                canManage
                  ? 'أنشئ أول موقع للمؤسسة. ستُنشأ معه صفحة رئيسية وإعدادات افتراضية.'
                  : 'لم يُنشئ أحد موقعًا بعد.'
              }
            />
          </CardBody>
        </Card>
      ) : (
        <ul className="space-y-3">
          {sites.map((site) => (
            <li key={site.id}>
              <Link href={`${base}/${site.id}`} className="block">
                <Card className="transition hover:border-primary/40">
                  <CardBody className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-fg">{site.name}</p>
                      <p className="truncate text-sm text-muted" dir="ltr">
                        /{site.slug}
                      </p>
                    </div>
                    <Badge tone={site.status === 'published' ? 'success' : 'neutral'}>
                      {site.status === 'published' ? 'منشور' : 'مسودة'}
                    </Badge>
                  </CardBody>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {/* The form is offered only to someone who could actually submit it.
          Hiding it is courtesy; the action re-checks the permission anyway. */}
      {canManage && (
        <Card>
          <CardBody className="space-y-4">
            <h2 className="font-semibold text-fg">موقع جديد</h2>
            <CreateSiteForm orgSlug={ctx.organizationSlug} branchSlug={ctx.branchSlug} />
          </CardBody>
        </Card>
      )}
    </div>
  );
}
