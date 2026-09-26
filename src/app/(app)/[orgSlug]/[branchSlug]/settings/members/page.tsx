import { notFound } from 'next/navigation';
import { UserCog } from 'lucide-react';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/patterns/states';
import { CreateMemberDirectForm, RemoveMember } from './invite-forms';

export const metadata = { title: 'الموظفون' };
export const dynamic = 'force-dynamic';

const ROLE_NAMES: Record<string, string> = {
  owner: 'المالك',
  admin: 'مدير النظام',
  manager: 'مدير فرع',
  accountant: 'محاسب',
  cashier: 'كاشير',
  kitchen: 'شيف',
  barista: 'باريستا',
  waiter: 'كابتن',
  staff: 'موظف',
};

export default async function MembersPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'member.read')) notFound();

  const supabase = createSupabaseServerClient();

  const [{ data: members }, { data: org }] = await Promise.all([
    supabase
      .from('organization_members')
      .select('id, user_id, status, all_branches, joined_at')
      .eq('organization_id', ctx.organizationId),
    supabase.from('organizations').select('owner_user_id').eq('id', ctx.organizationId).single(),
  ]);

  const memberIds = (members ?? []).map((m) => m.id);
  const userIds = (members ?? []).map((m) => m.user_id);

  const [{ data: grants }, { data: profiles }] = await Promise.all([
    memberIds.length
      ? supabase
          .from('user_roles')
          .select('member_id, branch_id, roles!inner(key, name_ar)')
          .in('member_id', memberIds)
      : Promise.resolve({ data: [] }),
    userIds.length
      ? supabase.from('profiles').select('id, full_name, phone').in('id', userIds)
      : Promise.resolve({ data: [] }),
  ]);

  // Roles this organization actually has, for the invite form. An invitation
  // can only ever carry one of these; the database checks that again.
  const { data: roleRows } = await supabase
    .from('roles')
    .select('id, key, name_ar')
    .eq('organization_id', ctx.organizationId)
    .order('name_ar');

  const canManage = can(ctx, 'member.manage');

  const nameById = new Map(
    (profiles ?? []).map((p) => [p.id, { name: p.full_name, phone: p.phone }]),
  );

  const rows = (members ?? []).map((member) => {
    const own = (grants ?? []).filter((g) => g.member_id === member.id);
    return {
      id: member.id,
      userId: member.user_id,
      name: nameById.get(member.user_id)?.name ?? '—',
      phone: nameById.get(member.user_id)?.phone ?? null,
      status: member.status,
      allBranches: member.all_branches,
      roles: own.map((g) => {
        const role = g.roles as unknown as { key: string; name_ar: string } | null;
        return role ? (ROLE_NAMES[role.key] ?? role.name_ar) : '—';
      }),
    };
  });

  const ownerUserId = org?.owner_user_id ?? null;

  return (
    <div className="space-y-4">
    {canManage ? (
      <Card>
        <CardHeader>
          <CardTitle>إنشاء حساب موظف مباشرةً</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          <p className="text-xs text-muted">
            يعمل الحساب فورًا بالبريد وكلمة المرور اللي تدخلها — بدون دعوة
            ولا بريد إلكتروني. استخدمه لموظف واقف معاك جاهز لبدء الشيفت.
          </p>
          <CreateMemberDirectForm
            orgSlug={ctx.organizationSlug}
            branchSlug={ctx.branchSlug}
            roles={(roleRows ?? []).map((r) => ({
              id: r.id,
              label: ROLE_NAMES[r.key] ?? r.name_ar,
            }))}
          />
        </CardBody>
      </Card>
    ) : null}

    <Card>
      <CardHeader>
        <CardTitle>فريق العمل</CardTitle>
      </CardHeader>
      {rows.length === 0 ? (
        <EmptyState icon={UserCog} title="لا يوجد موظفون" />
      ) : (
        <CardBody className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">فريق العمل وصلاحياتهم</caption>
              <thead>
                <tr className="border-b border-line text-xs text-muted">
                  <th scope="col" className="p-3 text-start font-medium">الموظف</th>
                  <th scope="col" className="p-3 text-start font-medium">الدور</th>
                  <th scope="col" className="p-3 text-start font-medium">الفروع</th>
                  <th scope="col" className="p-3 text-start font-medium">الحالة</th>
                  {canManage ? <th scope="col" className="p-3 text-start font-medium"> </th> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((member) => (
                  <tr key={member.id} className="border-b border-line last:border-0">
                    <td className="p-3">
                      <span className="font-medium">{member.name}</span>
                      {member.phone && (
                        <span className="lb-numeric ms-2 text-xs text-muted">{member.phone}</span>
                      )}
                    </td>
                    <td className="p-3">
                      <span className="flex flex-wrap gap-1">
                        {member.roles.map((role, i) => (
                          <Badge key={i} tone="info">
                            {role}
                          </Badge>
                        ))}
                      </span>
                    </td>
                    <td className="p-3 text-muted">
                      {member.allBranches ? 'كل الفروع' : 'فروع محددة'}
                    </td>
                    <td className="p-3">
                      <Badge tone={member.status === 'active' ? 'success' : 'neutral'}>
                        {member.status === 'active' ? 'نشط' : member.status}
                      </Badge>
                    </td>
                    {canManage ? (
                      <td className="p-3">
                        {member.userId !== ownerUserId ? (
                          <RemoveMember
                            orgSlug={ctx.organizationSlug}
                            branchSlug={ctx.branchSlug}
                            memberId={member.id}
                          />
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      )}
    </Card>
    </div>
  );
}
