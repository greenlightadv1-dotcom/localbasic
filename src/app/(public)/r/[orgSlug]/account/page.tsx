import type { Metadata } from 'next';
import { Card, CardBody } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { AccountShell, requireCustomer } from './shell';
import { ProfileForm } from './forms';

export const dynamic = 'force-dynamic';

// An account page is private to one person. It must never be indexed, and
// never cached anywhere that could hand it to a different visitor.
export const metadata: Metadata = {
  title: 'حسابي',
  robots: { index: false, follow: false },
};

export default async function AccountPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { saved?: string };
}) {
  const { site, profile } = await requireCustomer(params.orgSlug);

  return (
    <AccountShell site={site} orgSlug={params.orgSlug} active="" title="بياناتي">
      {searchParams.saved && <Alert tone="success">تم حفظ بياناتك.</Alert>}
      <Card>
        <CardBody className="p-5">
          <ProfileForm
            orgSlug={params.orgSlug}
            name={profile.fullName}
            phone={profile.phone}
            email={profile.email}
          />
        </CardBody>
      </Card>
    </AccountShell>
  );
}
