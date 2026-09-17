import { Truck } from 'lucide-react';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { listSuppliers } from '@/modules/retail/purchasing/service';
import { PageHeader } from '@/components/patterns/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/patterns/states';
import { SupplierForm, SupplierToggle } from './forms';

export const metadata = { title: 'الموردون' };

export default async function SuppliersPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  const suppliers = await listSuppliers(ctx, { includeInactive: true });
  const canManage = can(ctx, 'retail.supplier.manage');

  return (
    <div className="space-y-5">
      <PageHeader title="الموردون" description={`${suppliers.length} مورد`} />

      {canManage ? (
        <Card className="p-4">
          <h2 className="mb-3 text-sm font-bold text-fg">إضافة مورد</h2>
          <SupplierForm orgSlug={params.orgSlug} branchSlug={params.branchSlug} />
        </Card>
      ) : null}

      <Card>
        {suppliers.length === 0 ? (
          <EmptyState
            icon={Truck}
            title="لا يوجد موردون بعد"
            description="أضف موردًا لتتمكّن من تسجيل أوامر الشراء واستلام البضاعة."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">قائمة الموردين</caption>
              <thead>
                <tr className="border-b border-line text-start text-xs text-muted">
                  <th scope="col" className="p-3 text-start font-medium">المورد</th>
                  <th scope="col" className="p-3 text-start font-medium">الهاتف</th>
                  <th scope="col" className="p-3 text-start font-medium">البريد</th>
                  <th scope="col" className="p-3 text-start font-medium">الحالة</th>
                  {canManage ? <th scope="col" className="p-3 text-start font-medium"> </th> : null}
                </tr>
              </thead>
              <tbody>
                {suppliers.map((s) => (
                  <tr key={s.id} className="border-b border-line last:border-0">
                    <td className="p-3 font-medium text-fg">{s.name}</td>
                    <td className="p-3 text-muted" dir="ltr">{s.phone ?? '—'}</td>
                    <td className="p-3 text-muted" dir="ltr">{s.email ?? '—'}</td>
                    <td className="p-3">
                      <Badge tone={s.isActive ? 'success' : 'neutral'}>
                        {s.isActive ? 'نشط' : 'موقوف'}
                      </Badge>
                    </td>
                    {canManage ? (
                      <td className="p-3">
                        <SupplierToggle
                          orgSlug={params.orgSlug}
                          branchSlug={params.branchSlug}
                          id={s.id}
                          isActive={s.isActive}
                        />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
