import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getOnlineMenu } from '@/modules/restaurant/online/service';
import { Storefront } from './storefront';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'اطلب أونلاين',
  robots: { index: false, follow: false },
};

/**
 * The guest ordering surface.
 *
 * Anonymous, and addressed by public slugs — no session, no ids in the URL.
 * The menu comes from a SECURITY DEFINER function that proves the branch
 * belongs to the organization; a storefront with online ordering switched off,
 * or a slug pair that does not belong together, is simply not found.
 */
export default async function OrderPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const menu = await getOnlineMenu({
    orgSlug: params.orgSlug,
    branchSlug: params.branchSlug,
  }).catch(() => null);

  if (!menu || menu.items.length === 0) notFound();

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <h1 className="mb-6 text-2xl font-extrabold text-fg">اطلب أونلاين</h1>
      <Storefront
        orgSlug={params.orgSlug}
        branchSlug={params.branchSlug}
        items={menu.items}
        modifierGroups={menu.modifierGroups}
        currency="EGP"
      />
    </div>
  );
}
