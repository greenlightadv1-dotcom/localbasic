import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { Card, CardBody } from '@/components/ui/card';
import { Logo, PoweredBy } from '@/components/brand/logo';
import { claimGuestOrder, currentUser } from '@/modules/restaurant/account/service';
import { CustomerAuthForm } from '../../r/[orgSlug]/account/forms';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'احفظ طلبك',
  robots: { index: false, follow: false },
};

/**
 * "Create an account to save your orders and addresses."
 *
 * Reached from the guest tracking page, carrying the order-status token the
 * customer is already holding. That token is the entire authorisation to
 * attach the order — see the long note on `customer_claim_order` in migration
 * 0040 for why nothing weaker (an order number, a phone, an email) is
 * accepted, and why this is the only claim path that exists.
 *
 * This route has no restaurant slug and does not need one: the claim returns
 * the restaurant the order belongs to, and that is where the customer lands.
 */
export default async function JoinPage({
  searchParams,
}: {
  searchParams: { token?: string };
}) {
  const token = searchParams.token ?? '';
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(token)) notFound();

  // Already signed in: attach it now and go straight to the order history.
  if (await currentUser()) {
    const claimed = await claimGuestOrder({ token });
    // A claim can legitimately fail — the window closed, or the order already
    // belongs to an account. Either way the tracking link still works, so send
    // them back to it rather than to an error.
    redirect(claimed ? `/r/${claimed.orgSlug}/account/orders?claimed=1` : `/order/track/${token}`);
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-10">
      <Logo className="h-12" />
      <main className="w-full max-w-md">
        <Card>
          <CardBody className="space-y-5 p-6">
            <div className="space-y-1">
              <h1 className="text-lg font-bold">أنشئ حسابًا لحفظ طلباتك وعناوينك</h1>
              <p className="text-sm text-muted">
                سنربط هذا الطلب بحسابك، وتقدر تتابع طلباتك القادمة من مكان واحد.
              </p>
            </div>
            <CustomerAuthForm mode="sign-up" orgSlug={null} claim={token} />
          </CardBody>
        </Card>
      </main>
      <PoweredBy />
    </div>
  );
}
