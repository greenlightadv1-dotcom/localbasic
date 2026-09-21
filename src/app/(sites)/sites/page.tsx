import Link from 'next/link';
import { Globe } from 'lucide-react';
import { PageHeader } from '@/components/patterns/page-header';
import { Card, CardBody } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/patterns/states';
import { listMySites } from '@/modules/sites/service';
import { requireSignedIn } from '@/modules/sites/guard';
import { CreateSiteForm } from './create-site-form';

export const metadata = { title: 'مواقعي' };
// Reads the session, so it can never be prerendered or cached.
export const dynamic = 'force-dynamic';

export default async function MySitesPage() {
  // A signed-out visitor is redirected rather than shown an error page.
  // Ownership itself is enforced by RLS, not here.
  await requireSignedIn();
  const sites = await listMySites();

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8">
      <PageHeader
        title="مواقعي"
        description="كل موقع له صفحاته وأقسامه وإعداداته الخاصة."
      />

      {sites.length === 0 ? (
        <Card>
          <CardBody>
            <EmptyState
              icon={Globe}
              title="لا توجد مواقع بعد"
              description="أنشئ موقعك الأول. سيُنشأ معه صفحة رئيسية وإعدادات افتراضية."
            />
          </CardBody>
        </Card>
      ) : (
        <ul className="space-y-3">
          {sites.map((site) => (
            <li key={site.id}>
              <Link href={`/sites/${site.id}`} className="block">
                <Card className="transition hover:border-primary/40">
                  <CardBody className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-fg">{site.name}</p>
                      <p className="truncate text-sm text-muted" dir="ltr">
                        /{site.slug}
                      </p>
                    </div>
                    <Badge tone={site.status === 'published' ? 'success' : 'neutral'}>
                      {site.status === 'published' ? 'منشور' : 'مسودة'}
                    </Badge>
                  </CardBody>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Card>
        <CardBody className="space-y-4">
          <h2 className="font-semibold text-fg">موقع جديد</h2>
          <CreateSiteForm />
        </CardBody>
      </Card>
    </div>
  );
}
