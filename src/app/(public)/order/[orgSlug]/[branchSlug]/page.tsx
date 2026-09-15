import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getOnlineMenu, getStorefront } from '@/modules/restaurant/online/service';
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
  const [menu, info] = await Promise.all([
    getOnlineMenu({ orgSlug: params.orgSlug, branchSlug: params.branchSlug }).catch(() => null),
    getStorefront({ orgSlug: params.orgSlug, branchSlug: params.branchSlug }),
  ]);

  if (!menu || menu.items.length === 0 || !info) notFound();

  // Both switched off means there is no way to complete an order, so the
  // storefront is closed rather than a dead end.
  if (!info.pickupEnabled && !info.deliveryEnabled) notFound();

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-extrabold text-fg">{info.organizationName}</h1>
      <p className="mb-6 text-sm text-muted">{info.branchName}</p>
      <Storefront
        orgSlug={params.orgSlug}
        branchSlug={params.branchSlug}
        items={menu.items}
        modifierGroups={menu.modifierGroups}
        currency={info.currency}
        pickupEnabled={info.pickupEnabled}
        deliveryEnabled={info.deliveryEnabled}
      />
    </div>
  );
}
