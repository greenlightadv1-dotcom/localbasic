import { redirect } from 'next/navigation';
import { resolveTenantContext } from '@/modules/core/tenancy/context';
import { SETTINGS_NAVIGATION } from '@/config/modules';

export default async function SettingsIndex({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  const first = SETTINGS_NAVIGATION.find((item) =>
    Array.isArray(item.permission)
      ? item.permission.some((p) => ctx.permissions.has(p))
      : ctx.permissions.has(item.permission),
  );
  redirect(`/${ctx.organizationSlug}/${ctx.branchSlug}${first?.href ?? ''}`);
}
