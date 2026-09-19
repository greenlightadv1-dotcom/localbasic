import Link from 'next/link';
import { listWebsites } from '@/modules/platform/websites/service';
import { adminMetadata } from '@/modules/platform/admin/metadata';
import { AdminHeading, Panel, formatDate } from '../ui';

export const generateMetadata = adminMetadata('المواقع');
export const dynamic = 'force-dynamic';

const TYPE_LABELS: Record<string, string> = {
  restaurant: 'مطعم',
  clinic: 'عيادة',
  workshop: 'ورشة',
  retail: 'تجزئة',
  custom: 'مخصص',
};

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    published: 'bg-success/15 text-success',
    draft: 'bg-warn/15 text-warn',
    archived: 'bg-surface text-muted',
  };
  const labels: Record<string, string> = {
    published: 'منشور',
    draft: 'مسودة',
    archived: 'مؤرشف',
  };
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-semibold ${styles[status] ?? styles.archived}`}>
      {labels[status] ?? status}
    </span>
  );
}

export default async function WebsitesPage() {
  const websites = await listWebsites();

  return (
    <>
      <AdminHeading
        title="المواقع"
        lead="مواقع العملاء التي تبنيها المنصة. المسودة تُحرَّر بحرية؛ ما يراه الزائر هو النسخة المنشورة فقط."
      />

      <div className="mb-4 flex justify-end">
        <Link
          href="/admin/websites/new"
          className="h-9 rounded bg-primary px-4 text-sm font-semibold leading-9 text-primary-fg hover:bg-primary/90"
        >
          موقع جديد
        </Link>
      </div>

      <Panel className="overflow-x-auto">
        {websites.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted">
            لا توجد مواقع بعد. ابدأ بإنشاء موقع لأحد العملاء.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-line text-start text-xs text-muted">
              <tr>
                <th className="p-3 text-start font-medium">الموقع</th>
                <th className="p-3 text-start font-medium">العميل</th>
                <th className="p-3 text-start font-medium">النوع</th>
                <th className="p-3 text-start font-medium">الحالة</th>
                <th className="p-3 text-start font-medium">آخر تحديث</th>
                <th className="p-3 text-start font-medium">آخر نشر</th>
                <th className="p-3 text-start font-medium" />
              </tr>
            </thead>
            <tbody>
              {websites.map((w) => (
                <tr key={w.id} className="border-b border-line last:border-0">
                  <td className="p-3">
                    <span className="font-semibold text-fg">{w.name}</span>
                    <span className="block font-mono text-xs text-muted" dir="ltr">
                      /{w.slug}
                    </span>
                  </td>
                  <td className="p-3 text-muted">{w.organizationName}</td>
                  <td className="p-3 text-muted">{TYPE_LABELS[w.siteType] ?? w.siteType}</td>
                  <td className="p-3">
                    <StatusPill status={w.status} />
                  </td>
                  <td className="p-3 text-xs text-muted">{formatDate(w.updatedAt)}</td>
                  <td className="p-3 text-xs text-muted">
                    {w.publishedAt ? formatDate(w.publishedAt) : '—'}
                  </td>
                  <td className="p-3">
                    <Link
                      href={`/admin/websites/${w.id}`}
                      className="text-xs font-semibold text-primary hover:underline"
                    >
                      فتح
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
