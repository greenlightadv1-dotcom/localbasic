import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getStoreCatalog, getStoreContext } from '@/modules/retail/store/service';
import { Storefront } from './storefront';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'المتجر',
  // A guest ordering surface is not something to index: it is per-shop, and
  // its stock changes by the minute.
  robots: { index: false, follow: false },
};

/**
 * The retail storefront.
 *
 * Anonymous, addressed by public slugs — no session, no identifiers in the
 * URL. Everything comes from SECURITY DEFINER projections that prove the
 * branch belongs to the organization and that the shop has actually opened its
 * store; a closed store and a slug pair that do not belong together are both
 * simply not found.
 */
export default async function ShopPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; branchSlug: string };
  searchParams: { q?: string };
}) {
  const store = await getStoreContext({
    orgSlug: params.orgSlug,
    branchSlug: params.branchSlug,
  });
  if (!store) notFound();

  // Neither fulfilment type on means there is no way to complete an order, so
  // the shop is closed rather than a dead end.
  if (!store.pickup && !store.delivery) notFound();

  const catalog = await getStoreCatalog(params.orgSlug, params.branchSlug, searchParams.q);

  return (
    <Storefront
      orgSlug={params.orgSlug}
      branchSlug={store.branchSlug}
      name={store.name}
      currency={store.currency}
      pickup={store.pickup}
      delivery={store.delivery}
      deliveryFeeCents={store.deliveryFeeCents}
      minOrderCents={store.minOrderCents}
      catalog={catalog}
      search={searchParams.q ?? ''}
    />
  );
}
