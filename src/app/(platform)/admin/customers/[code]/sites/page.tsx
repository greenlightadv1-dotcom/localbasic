import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getOrganizationByCode } from '@/modules/platform/billing/service';
import { platformListSites } from '@/modules/platform/sites/service';
import { AdminHeading, Panel, CustomerCode } from '../../../ui';

export async function generateMetadata({ params }: { params: { code: string } }) {
  return { title: `مواقع ${decodeURIComponent(params.code)}`, robots: { index: false, follow: false } };
}

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, string> = { draft: 'مسودة', published: 'منشور' };

/**
 * The site picker behind a customer's profile.
 *
 * Read-only. It exists so an operator can find the site to open the Theme
 * Customizer on — it never creates, renames or deletes a site itself, which
 * stays the organization's own authority.
 */
export default async function CustomerSitesPage({ params }: { params: { code: string } }) {
  const code = decodeURIComponent(params.code);
  const org = await getOrganizationByCode(code);
  if (!org) notFound();

  const sites = await platformListSites(code);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <AdminHeading title="مواقع العميل" lead={org.name} />

      <div className="mb-4 flex items-center gap-2 text-sm text-muted">
        <CustomerCode code={org.customerCode} />
        <Link href={`/admin/customers/${encodeURIComponent(code)}`} className="text-primary hover:underline">
          رجوع لملف العميل
        </Link>
      </div>

      <Panel>
        {sites.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted">
            لا توجد مواقع لهذا العميل بعد. إنشاء موقع جديد يتم من داخل حساب العميل.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {sites.map((site) => (
              <li key={site.id}>
                <Link
                  href={`/admin/customers/${encodeURIComponent(code)}/sites/${site.id}`}
                  className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-surface"
                >
                  <span>
                    <span className="font-semibold text-fg">{site.name}</span>
                    <span className="ms-2 text-xs text-muted" dir="ltr">
                      {site.slug}
                    </span>
                  </span>
                  <span
                    className={
                      site.status === 'published'
                        ? 'rounded bg-success/15 px-2 py-0.5 text-xs font-semibold text-success'
                        : 'rounded bg-surface px-2 py-0.5 text-xs font-semibold text-muted'
                    }
                  >
                    {STATUS_LABEL[site.status] ?? site.status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
