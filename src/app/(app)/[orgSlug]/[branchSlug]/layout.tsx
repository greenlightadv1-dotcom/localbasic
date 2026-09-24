import { notFound } from 'next/navigation';
import { AppError } from '@/lib/errors';
import { resolveTenantContext } from '@/modules/core/tenancy/context';
import { AppShell } from '@/components/patterns/app-shell';
import { getBranding } from '@/modules/core/branding/service';
import { MembershipWatch } from '@/modules/core/members/membership-watch';

/**
 * The authenticated workspace shell.
 *
 * Tenant resolution happens once here and every page below inherits it. A user
 * who is not a member, or who cannot reach this branch, gets a 404 — never a
 * 403 — so slugs reveal nothing about what exists.
 */
export default async function BranchLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { orgSlug: string; branchSlug: string };
}) {
  let ctx;
  try {
    ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }

  const branding = await getBranding(ctx);

  return (
    <AppShell ctx={ctx} branding={branding}>
      <MembershipWatch userId={ctx.userId} />
      {children}
    </AppShell>
  );
}
