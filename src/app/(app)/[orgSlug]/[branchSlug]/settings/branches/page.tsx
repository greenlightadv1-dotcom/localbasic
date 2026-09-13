import { notFound } from 'next/navigation';
import { Store } from 'lucide-react';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/patterns/states';

export const metadata = { title: 'الفروع' };
export const dynamic = 'force-dynamic';

export default async function BranchesPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'branch.manage')) notFound();

  const supabase = createSupabaseServerClient();
  const { data: branches } = await supabase
    .from('branches')
    .select('id, slug, name, address, phone, is_active')
    .eq('organization_id', ctx.organizationId)
    .is('deleted_at', null)
    .order('created_at');

  const rows = branches ?? [];

  return (
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
  );
}
