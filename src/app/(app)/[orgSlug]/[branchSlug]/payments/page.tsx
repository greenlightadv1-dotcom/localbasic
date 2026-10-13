import { redirect } from 'next/navigation';

/**
 * /payments was a sidebar target with no page behind it. The payment methods
 * screen lives under Settings; anyone arriving here (an old link, a typed
 * URL) is sent there. The settings page does its own permission check.
 */
export default function PaymentsRedirect({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  redirect(`/${params.orgSlug}/${params.branchSlug}/settings/payments`);
}
