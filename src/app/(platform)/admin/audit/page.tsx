import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requirePlatformAdmin } from '@/modules/platform/admin/context';
import { AdminHeading, Panel, formatDate } from '../ui';
import { adminMetadata } from '@/modules/platform/admin/metadata';

export const generateMetadata = adminMetadata('سجل المنصة');

/**
 * Platform-side audit. Reads the same audit_logs every tenant writes to; the
 * additive platform SELECT policy in 0029 is what widens the view, so there is
 * no second audit trail to keep in step.
 */
export default async function PlatformAuditPage() {
  await requirePlatformAdmin();
  const supabase = createSupabaseServerClient();

  const { data } = await supabase
    .from('audit_logs')
    .select('id, organization_id, action, entity_type, entity_id, actor_label, created_at, after')
    .like('action', 'platform.%')
    .order('created_at', { ascending: false })
    .limit(200);

  const rows = data ?? [];

  return (
    <>
      <AdminHeading title="سجل المنصة" lead="أحداث الإدارة: إنشاء مساحات عمل وتجديد اشتراكات." />
      <Panel>
        {rows.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted">لا توجد أحداث بعد.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-surface text-xs text-muted">
                <tr>
                  <th className="px-4 py-2.5 text-start font-semibold">التاريخ</th>
                  <th className="px-4 py-2.5 text-start font-semibold">الحدث</th>
                  <th className="px-4 py-2.5 text-start font-semibold">الكيان</th>
                  <th className="px-4 py-2.5 text-start font-semibold">بواسطة</th>
                  <th className="px-4 py-2.5 text-start font-semibold">التفاصيل</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-surface">
                    <td className="whitespace-nowrap px-4 py-3 text-muted">{formatDate(r.created_at)}</td>
                    <td className="px-4 py-3 font-semibold text-fg" dir="ltr">{r.action}</td>
                    <td className="px-4 py-3 text-muted" dir="ltr">{r.entity_type}</td>
                    <td className="px-4 py-3 text-muted">{r.actor_label ?? '—'}</td>
                    <td className="max-w-sm truncate px-4 py-3 text-xs text-muted" dir="ltr">
                      {r.after ? JSON.stringify(r.after) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
