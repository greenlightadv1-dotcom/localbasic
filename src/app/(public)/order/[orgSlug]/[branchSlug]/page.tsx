import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getOnlineMenu, getStorefront } from '@/modules/restaurant/online/service';
import { lavechiCssVars, LAVECHI_SPLASH_BACKGROUND } from '@/modules/restaurant/website/lavechi-theme';
import { Storefront } from './storefront';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'اطلب أونلاين',
  robots: { index: false, follow: false },
};

/**
 * The guest ordering surface.
 *
 * Anonymous, and addressed by public slugs — no session, no ids in the URL,
 * no account. A phone number plus this browser's device id (checked against
 * WhatsApp-verified devices) is the only identity involved. The menu comes
 * from a SECURITY DEFINER function that proves the branch belongs to the
 * organization; a storefront with online ordering switched off, or a slug
 * pair that does not belong together, is simply not found.
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
    <div
      className="min-h-dvh"
      style={{ ...lavechiCssVars(), background: LAVECHI_SPLASH_BACKGROUND } as React.CSSProperties}
    >
      <div className="mx-auto max-w-5xl px-4 py-8 text-[#F4F1E4] sm:px-6">
          <div className="mb-6 flex items-center gap-3">
            {info.logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element -- an
              // organization-supplied external URL, not a build-time asset.
              <img
                src={info.logoUrl}
                alt=""
                className="lavechi-ring-pulse h-12 w-12 shrink-0 rounded-full object-cover"
              />
            )}
            <div>
              <h1 className="font-reem text-2xl font-normal tracking-wide text-fg">{info.organizationName}</h1>
              <p className="text-sm text-muted">{info.branchName}</p>
            </div>
          </div>
          <Storefront
            orgSlug={params.orgSlug}
            branchSlug={params.branchSlug}
            organizationName={info.organizationName}
            items={menu.items}
            modifierGroups={menu.modifierGroups}
            currency={info.currency}
            pickupEnabled={info.pickupEnabled}
            deliveryEnabled={info.deliveryEnabled}
          />
      </div>
    </div>
  );
}
