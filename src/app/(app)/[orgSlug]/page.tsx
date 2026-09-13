import { redirect } from 'next/navigation';
import { resolveTenantContext } from '@/modules/core/tenancy/context';

/** Land the user on their first accessible branch. */
export default async function OrganizationIndexPage({
  params,
}: {
  params: { orgSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug);
  redirect(`/${ctx.organizationSlug}/${ctx.branchSlug}`);
}
