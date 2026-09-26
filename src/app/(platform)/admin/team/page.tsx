import { getPlatformContext } from '@/modules/platform/admin/context';
import { listPlatformAdmins } from '@/modules/platform/admin/roster';
import { adminMetadata } from '@/modules/platform/admin/metadata';
import { AdminHeading, Panel, formatDate } from '../ui';
import { GrantAdminForm, CreateAdminDirectForm, RevokeAdminButton } from './forms';

export const generateMetadata = adminMetadata('فريق المنصة');

/**
 * Who may operate the platform.
 *
 * Any admin may read the roster — knowing who else has the keys is part of
 * operating safely. Only an OWNER may change it, and that is enforced in the
 * database (migration 0048), not by hiding the form.
 *
 * The first admin is still installed out-of-band, on purpose: a self-service
 * path on an empty roster would let the first person through the door claim
 * the platform. See docs/SUPABASE.md.
 */
export default async function PlatformTeamPage({
  searchParams,
}: {
  searchParams: { granted?: string; revoked?: string };
}) {
  // The layout already gated this; reading the context again is free (it is
  // React-cached per request) and tells the page which controls to offer.
  const ctx = await getPlatformContext();
  const admins = await listPlatformAdmins();
  const isOwner = ctx?.role === 'owner';

  return (
    <>
      <AdminHeading
        title="فريق المنصة"
        lead="من يستطيع تشغيل المنصة. المالك وحده يضيف أو يسحب الصلاحية."
      />

      {searchParams.granted === '1' || searchParams.revoked === '1' ? (
        <p
          data-testid="roster-saved"
          className="mb-4 rounded border border-success/30 bg-success/10 px-4 py-3 text-sm font-semibold text-success"
        >
          {searchParams.granted === '1' ? 'تم منح الصلاحية.' : 'تم سحب الصلاحية.'}
        </p>
      ) : null}

      {isOwner ? (
        <>
          <Panel className="mb-4 p-4">
            <h2 className="mb-3 text-sm font-bold text-fg">إنشاء حساب مشغّل مباشرةً</h2>
            <p className="mb-3 text-xs text-muted">
              يعمل الحساب فورًا بالبريد وكلمة المرور اللي تدخلها هنا — بدون دعوة
              ولا تغيير إجباري لكلمة المرور عند أول دخول.
            </p>
            <CreateAdminDirectForm />
          </Panel>

          <Panel className="mb-4 p-4">
            <h2 className="mb-3 text-sm font-bold text-fg">منح صلاحية لحساب موجود</h2>
            <p className="mb-3 text-xs text-muted">
              يجب أن يكون لدى الشخص حساب على المنصة بالفعل — هذه الشاشة تمنح صلاحية
              ولا تُنشئ حسابًا.
            </p>
            <GrantAdminForm />
          </Panel>
        </>
      ) : (
        <Panel className="mb-4 p-4">
          <p className="text-sm text-muted">
            للاطلاع فقط. إضافة أو سحب الصلاحيات متاح لمالك المنصة.
          </p>
        </Panel>
      )}

      <Panel>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">قائمة مشغّلي المنصة</caption>
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                <th scope="col" className="p-3 text-start font-medium">البريد</th>
                <th scope="col" className="p-3 text-start font-medium">الاسم</th>
                <th scope="col" className="p-3 text-start font-medium">الدور</th>
                <th scope="col" className="p-3 text-start font-medium">الحالة</th>
                <th scope="col" className="p-3 text-start font-medium">منذ</th>
                {isOwner ? <th scope="col" className="p-3 text-start font-medium"> </th> : null}
              </tr>
            </thead>
            <tbody data-testid="admin-roster">
              {admins.map((a) => (
                <tr key={a.userId} className="border-b border-line last:border-0">
                  <td className="p-3 font-medium text-fg" dir="ltr">{a.email}</td>
                  <td className="p-3 text-muted">{a.fullName ?? '—'}</td>
                  <td className="p-3">
                    <span
                      className={
                        a.role === 'owner'
                          ? 'rounded bg-primary-soft px-2 py-0.5 text-xs font-semibold text-primary'
                          : 'rounded bg-surface px-2 py-0.5 text-xs font-semibold text-muted'
                      }
                    >
                      {a.role === 'owner' ? 'مالك المنصة' : 'موظف'}
                    </span>
                  </td>
                  <td className="p-3">
                    {a.isActive ? (
                      <span className="text-xs font-semibold text-success">نشط</span>
                    ) : (
                      <span className="text-xs text-muted">موقوف</span>
                    )}
                  </td>
                  <td className="p-3 text-xs text-muted">{formatDate(a.createdAt)}</td>
                  {isOwner ? (
                    <td className="p-3">
                      {a.isActive && a.userId !== ctx?.user.id ? (
                        <RevokeAdminButton userId={a.userId} email={a.email} />
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
