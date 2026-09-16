import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { Card, CardBody } from '@/components/ui/card';
import { getWebsite } from '@/modules/restaurant/website/service';
import { currentUser } from '@/modules/restaurant/account/service';
import { AccountAuthShell } from '../shell';
import { CustomerAuthForm } from '../forms';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'تسجيل الدخول',
  robots: { index: false, follow: false },
};

/**
 * Customer sign-in, in the restaurant's own branding.
 *
 * This is NOT the staff sign-in at /sign-in, and the separation is the point:
 * that flow sends a new account to workspace onboarding, while this one
 * returns the customer to the restaurant. Both use the same Supabase Auth —
 * there is one identity system, not two — but signing in here confers no
 * membership, no role and no permission in any organization.
 */
export default async function CustomerSignInPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { claim?: string };
}) {
  const site = await getWebsite(params.orgSlug);
  if (!site) notFound();

  // Already signed in: there is nothing to do here.
  if (await currentUser()) redirect(`/r/${params.orgSlug}/account`);

  const claim = /^[A-Za-z0-9_-]{22,64}$/.test(searchParams.claim ?? '')
    ? searchParams.claim!
    : null;

  return (
    <AccountAuthShell site={site} orgSlug={params.orgSlug}>
      <Card>
        <CardBody className="space-y-5 p-6">
          <div className="space-y-1">
            <h1 className="text-lg font-bold">تسجيل الدخول</h1>
            <p className="text-sm text-muted">تابع طلباتك وعناوينك المحفوظة.</p>
          </div>
          <CustomerAuthForm mode="sign-in" orgSlug={params.orgSlug} claim={claim} />
          <p className="text-center text-sm text-muted">
            ليس لديك حساب؟{' '}
            <Link
              href={`/r/${params.orgSlug}/account/sign-up${claim ? `?claim=${claim}` : ''}`}
              className="font-semibold text-primary hover:underline"
            >
              أنشئ حسابًا
            </Link>
          </p>
        </CardBody>
      </Card>
    </AccountAuthShell>
  );
}
