import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { getOnlineMenu, getStorefront } from '@/modules/restaurant/online/service';
import { getWebsite } from '@/modules/restaurant/website/service';
import { resolveTableCode } from '@/modules/restaurant/public/table-entry';
import { brandThemeVars } from '@/lib/theme/brand-theme';
import { StoreHeader } from '@/components/menu/food-ui';
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
 *
 * `?table=<code>` (a table's QR code) goes straight to that table's menu.
 *
 * The page is themed from the store's brand colors, which arrive already
 * resolved for its plan: its own on Growth/Scale, the LocalBasic palette on
 * Basic.
 */
export default async function OrderPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; branchSlug: string };
  searchParams: { table?: string | string[] };
}) {
  const table = await resolveTableCode(searchParams.table);
  if (table) redirect(`/p/${table}`);

  const [menu, info, site] = await Promise.all([
    getOnlineMenu({ orgSlug: params.orgSlug, branchSlug: params.branchSlug }).catch(() => null),
    getStorefront({ orgSlug: params.orgSlug, branchSlug: params.branchSlug }),
    getWebsite(params.orgSlug).catch(() => null),
  ]);

  if (!menu || menu.items.length === 0 || !info) notFound();

  // Both switched off means there is no way to complete an order, so the
  // storefront is closed rather than a dead end.
  if (!info.pickupEnabled && !info.deliveryEnabled) notFound();

  return (
    <div
      className="min-h-dvh bg-bg text-fg"
      style={brandThemeVars(info.primaryColor, info.secondaryColor) as React.CSSProperties}
    >
      <div className="mx-auto max-w-2xl">
        <StoreHeader
          name={info.organizationName}
          logoUrl={info.logoUrl}
          description={site?.tagline ?? site?.about ?? null}
          chips={[info.branchName]}
        />
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
    </div>
  );
}
