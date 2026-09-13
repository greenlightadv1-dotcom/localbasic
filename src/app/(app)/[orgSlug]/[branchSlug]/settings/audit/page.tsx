import { notFound } from 'next/navigation';
import { ScrollText } from 'lucide-react';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/patterns/states';

export const metadata = { title: 'سجل النشاط' };
export const dynamic = 'force-dynamic';

const ACTIONS: Record<string, string> = {
  'organization.provisioned': 'تم إنشاء المؤسسة',
  'restaurant.order.created': 'إنشاء طلب',
  'restaurant.order.status': 'تغيير حالة طلب',
  'restaurant.order.paid': 'تحصيل طلب',
  'restaurant.table.qr_issued': 'إصدار رمز QR',
};

/** Append-only: the log can be read, never edited or erased. */
export default async function AuditPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'audit.read')) notFound();

  const supabase = createSupabaseServerClient();
  const { data: entries } = await supabase
    .from('audit_logs')
    .select('id, action, entity_type, entity_id, actor_label, after, created_at')
    .eq('organization_id', ctx.organizationId)
    .order('created_at', { ascending: false })
    .limit(120);

  const rows = entries ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>سجل النشاط</CardTitle>
      </CardHeader>
      {rows.length === 0 ? (
        <EmptyState icon={ScrollText} title="لا يوجد نشاط مسجل" />
      ) : (
        <CardBody className="p-0">
          <ul className="divide-y divide-line">
            {rows.map((entry) => (
              <li key={entry.id} className="flex items-start justify-between gap-3 p-3 text-sm">
                <div className="min-w-0">
                  <p className="font-medium">{ACTIONS[entry.action] ?? entry.action}</p>
                  <p className="text-xs text-muted">
                    {entry.actor_label ?? 'النظام'}
                    {entry.after && typeof entry.after === 'object' && 'number' in entry.after ? (
                      <span className="lb-numeric ms-2">
                        #{String((entry.after as Record<string, unknown>).number)}
                      </span>
                    ) : null}
                  </p>
                </div>
                <div className="shrink-0 text-end">
                  <Badge>{entry.entity_type}</Badge>
                  <p className="lb-numeric mt-1 text-xs text-muted">
                    {new Date(entry.created_at).toLocaleString('ar-EG', {
                      day: '2-digit',
                      month: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </CardBody>
      )}
    </Card>
  );
}
