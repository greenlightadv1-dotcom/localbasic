import { resolveTenantContext } from '@/modules/core/tenancy/context';

/**
 * Normalises /{orgSlug} to /{orgSlug}/{branchSlug} so every page below can
 * rely on both being present. resolveTenantContext throws a 404 when the user
 * is not a member, so this also gates the whole subtree.
 */
export default async function OrganizationLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { orgSlug: string };
}) {
  return <>{children}</>;
}

export async function generateMetadata({ params }: { params: { orgSlug: string } }) {
  try {
    const ctx = await resolveTenantContext(params.orgSlug);
    return { title: { default: ctx.organizationName, template: `%s · ${ctx.organizationName}` } };
  } catch {
    return { title: 'LocalBasic' };
  }
}
