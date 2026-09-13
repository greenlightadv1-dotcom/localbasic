import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export const metadata = { title: 'الصلاحيات' };
export const dynamic = 'force-dynamic';

/**
 * Roles and what each one may do.
 *
 * Read-only for now: the editor is still to come, and showing the real matrix
 * is more useful than a form that cannot yet save.
 */
export default async function RolesPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'role.manage')) notFound();

  const supabase = createSupabaseServerClient();

  const { data: roles } = await supabase
    .from('roles')
    .select('id, key, name_ar, description, is_owner, is_system')
    .eq('organization_id', ctx.organizationId)
    .order('is_owner', { ascending: false })
    .order('key');

  const roleIds = (roles ?? []).map((r) => r.id);
  const { data: grants } = roleIds.length
    ? await supabase.from('role_permissions').select('role_id, permission_key').in('role_id', roleIds)
    : { data: [] };

  const { data: permissions } = await supabase
    .from('permissions')
    .select('key, description, group_key');

  const describe = new Map((permissions ?? []).map((p) => [p.key, p.description]));

  return (
    <div className="space-y-4">
      {(roles ?? []).map((role) => {
        const own = (grants ?? []).filter((g) => g.role_id === role.id);
        const financial = own.filter((g) =>
          /^(invoice|payment|treasury)\./.test(g.permission_key),
        ).length;
        return (
          <Card key={role.id}>
            <CardHeader className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>
                {role.name_ar}
                {role.is_owner && <Badge tone="info" className="ms-2">لا يمكن تعديله</Badge>}
              </CardTitle>
              <span className="flex gap-2">
                <Badge>{own.length} صلاحية</Badge>
                <Badge tone={financial > 0 ? 'warn' : 'success'}>
                  {financial > 0 ? `${financial} صلاحية مالية` : 'بدون صلاحيات مالية'}
                </Badge>
              </span>
            </CardHeader>
            <CardBody>
              {role.description && <p className="mb-3 text-sm text-muted">{role.description}</p>}
              <ul className="flex flex-wrap gap-1.5">
                {own.slice(0, 40).map((g) => (
                  <li key={g.permission_key}>
                    <span
                      title={describe.get(g.permission_key) ?? g.permission_key}
                      className="inline-block rounded-sm bg-surface px-2 py-0.5 text-xs text-muted"
                      dir="ltr"
                    >
                      {g.permission_key}
                    </span>
                  </li>
                ))}
                {own.length > 40 && (
                  <li className="text-xs text-muted">+{own.length - 40} أخرى</li>
                )}
              </ul>
            </CardBody>
          </Card>
        );
      })}
    </div>
  );
}
