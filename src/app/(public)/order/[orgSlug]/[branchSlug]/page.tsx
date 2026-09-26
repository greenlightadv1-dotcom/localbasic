import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getOnlineMenu, getStorefront } from '@/modules/restaurant/online/service';
import { currentUser, getAddresses, getProfile, getFavorites } from '@/modules/restaurant/account/service';
import { hexToRgbChannels } from '@/lib/color';
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

  // D3. A signed-in customer gets their saved addresses and their name and
  // number filled in; a guest gets exactly the D1 page. Ordering never
  // requires an account, and nothing below changes what the server will
  // accept — only what the form starts out holding.
  const user = await currentUser();
  const [profile, addresses, favorites] = user
    ? await Promise.all([
        getProfile(params.orgSlug),
        getAddresses(params.orgSlug),
        getFavorites(params.orgSlug),
      ])
    : [null, [], []];

  // The restaurant's own colors, not LocalBasic's — see 0068. Scoped as CSS
  // variables on this page's own root, exactly the way the Site Engine
  // renderer themes a published site, so brand adoption reads as one
  // mechanism used twice rather than two.
  const brandStyle = {
    ['--brand-primary' as string]: hexToRgbChannels(info.primaryColor),
    ['--brand-secondary' as string]: hexToRgbChannels(info.secondaryColor),
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6" style={brandStyle}>
      <div className="mb-6 flex items-center gap-3">
        {info.logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- an
          // organization-supplied external URL, not a build-time asset.
          <img
            src={info.logoUrl}
            alt=""
            className="h-12 w-12 shrink-0 rounded-full object-cover ring-1 ring-[rgb(var(--brand-primary)/0.3)]"
          />
        )}
        <div>
          <h1 className="text-2xl font-extrabold text-fg">{info.organizationName}</h1>
          <p className="text-sm text-muted">{info.branchName}</p>
        </div>
      </div>
      <Storefront
        orgSlug={params.orgSlug}
        branchSlug={params.branchSlug}
        items={menu.items}
        modifierGroups={menu.modifierGroups}
        currency={info.currency}
        pickupEnabled={info.pickupEnabled}
        deliveryEnabled={info.deliveryEnabled}
        savedAddresses={addresses.map((a) => ({
          id: a.id,
          label: a.label,
          address: a.address,
          isDefault: a.isDefault,
        }))}
        customerName={profile?.fullName ?? ''}
        customerPhone={profile?.phone ?? ''}
        customerEmail={profile?.email ?? ''}
        signedIn={Boolean(user)}
        favoriteProductIds={favorites.map((f) => f.productId)}
      />
    </div>
  );
}
