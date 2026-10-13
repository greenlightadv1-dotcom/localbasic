import { buildMetadata, RestaurantSite } from './page-shell';

// Tenant content, resolved per request. Caching it across requests would risk
// one restaurant's page being served for another, and a menu change should be
// visible immediately.
export const dynamic = 'force-dynamic';

export function generateMetadata({ params }: { params: { orgSlug: string } }) {
  return buildMetadata(params.orgSlug);
}

export default function RestaurantHomePage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { table?: string | string[] };
}) {
  return <RestaurantSite orgSlug={params.orgSlug} table={searchParams.table} />;
}
