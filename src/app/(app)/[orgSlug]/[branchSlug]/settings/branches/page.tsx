import { notFound } from 'next/navigation';
import { Store } from 'lucide-react';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getBranchLimitInfo } from '@/modules/core/branches/service';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/patterns/states';
import { CreateBranchForm } from './create-branch-form';

export const metadata = { title: 'الفروع' };
export const dynamic = 'force-dynamic';

export default async function BranchesPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'branch.manage')) notFound();

  const canCreate = can(ctx, 'branch.create');
  const supabase = createSupabaseServerClient();

  const [{ data: branches }, limitInfo] = await Promise.all([
    supabase
      .from('branches')
      .select('id, slug, name, address, phone, is_active')
      .eq('organization_id', ctx.organizationId)
      .is('deleted_at', null)
      .order('created_at'),
    canCreate ? getBranchLimitInfo(ctx) : Promise.resolve(null),
  ]);

  const rows = branches ?? [];
  const atLimit = Boolean(limitInfo?.limit != null && limitInfo.used >= limitInfo.limit);

  return (
    <div className="space-y-4">
    {canCreate ? (
      <Card>
        <CardHeader>
          <CardTitle>إضافة فرع</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          {limitInfo ? (
            <p className="text-xs text-muted">
              {limitInfo.limit != null
                ? `عدد الفروع: ${limitInfo.used} من ${limitInfo.limit} حسب باقتك${limitInfo.planName ? ` (${limitInfo.planName})` : ''}.`
                : `عدد الفروع: ${limitInfo.used} — لا يوجد حد لباقتك${limitInfo.planName ? ` (${limitInfo.planName})` : ''}.`}
            </p>
          ) : null}
          {atLimit ? (
            <p className="rounded border border-warn/30 bg-warn/10 px-3 py-2 text-xs font-semibold text-warn">
              وصلت لحد عدد الفروع المسموح في باقتك الحالية. قم بترقية الباقة لإضافة المزيد.
            </p>
          ) : (
            <CreateBranchForm orgSlug={ctx.organizationSlug} branchSlug={ctx.branchSlug} />
          )}
        </CardBody>
      </Card>
    ) : null}

    <Card>
      <CardHeader>
        <CardTitle>الفروع</CardTitle>
      </CardHeader>
      {rows.length === 0 ? (
        <EmptyState icon={Store} title="لا توجد فروع" />
      ) : (
        <CardBody className="p-0">
          <ul className="divide-y divide-line">
            {rows.map((branch) => (
              <li key={branch.id} className="flex items-start justify-between gap-3 p-4">
                <div>
                  <p className="font-medium">
                    {branch.name}
                    {branch.slug === ctx.branchSlug && (
                      <Badge tone="info" className="ms-2">
                        الفرع الحالي
                      </Badge>
                    )}
                  </p>
                  <p className="text-sm text-muted">{branch.address ?? '—'}</p>
                  {branch.phone && (
                    <p className="lb-numeric text-sm text-muted">{branch.phone}</p>
                  )}
                </div>
                <Badge tone={branch.is_active ? 'success' : 'neutral'}>
                  {branch.is_active ? 'نشط' : 'موقوف'}
                </Badge>
              </li>
            ))}
          </ul>
        </CardBody>
      )}
    </Card>
    </div>
  );
}
