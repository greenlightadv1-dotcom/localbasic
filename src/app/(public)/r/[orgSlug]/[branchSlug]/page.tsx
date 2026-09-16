import { buildMetadata, RestaurantSite } from '../page-shell';

export const dynamic = 'force-dynamic';

export function generateMetadata({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  return buildMetadata(params.orgSlug, params.branchSlug);
}

export default function RestaurantBranchPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  return <RestaurantSite orgSlug={params.orgSlug} branchSlug={params.branchSlug} />;
}
