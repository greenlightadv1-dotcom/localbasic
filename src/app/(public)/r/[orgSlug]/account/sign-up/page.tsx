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
  title: 'إنشاء حساب',
  robots: { index: false, follow: false },
};

/** Customer sign-up. Creates an Auth identity and nothing else — no workspace,
 *  no membership, no role. See the note on the sign-in page. */
export default async function CustomerSignUpPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { claim?: string; next?: string };
}) {
  const site = await getWebsite(params.orgSlug);
  if (!site) notFound();

  if (await currentUser()) redirect(`/r/${params.orgSlug}/account`);

  const claim = /^[A-Za-z0-9_-]{22,64}$/.test(searchParams.claim ?? '')
    ? searchParams.claim!
    : null;
  const next = /^\/(?!\/)\S*$/.test(searchParams.next ?? '') ? searchParams.next! : null;
  const carry = new URLSearchParams({
    ...(claim ? { claim } : {}),
    ...(next ? { next } : {}),
  }).toString();

  return (
    <AccountAuthShell site={site} orgSlug={params.orgSlug}>
      <Card>
        <CardBody className="space-y-5 p-6">
          <div className="space-y-1">
            <h1 className="text-lg font-bold">إنشاء حساب</h1>
            <p className="text-sm text-muted">
              رقم هاتفك هو حسابك — نتحقّق منه برمز عبر رسالة نصية.
            </p>
          </div>
          <CustomerAuthForm mode="sign-up" orgSlug={params.orgSlug} claim={claim} next={next} />
          <p className="text-center text-sm text-muted">
            لديك حساب بالفعل؟{' '}
            <Link
              href={`/r/${params.orgSlug}/account/sign-in${carry ? `?${carry}` : ''}`}
              className="font-semibold text-primary hover:underline"
            >
              تسجيل الدخول
            </Link>
          </p>
        </CardBody>
      </Card>
    </AccountAuthShell>
  );
}
