import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { getPinStatus } from '@/modules/restaurant/approvals/service';
import { DataUnavailable } from '@/components/patterns/data-unavailable';
import { ApprovalPinForm } from './form';

export const metadata = { title: 'رمز الموافقة' };
export const dynamic = 'force-dynamic';

export default async function ApprovalPinPage({
  params,
}: {
  params: { orgSlug: string; branchSlug: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'approval.grant')) notFound();
  if (!ctx.enabledModules.includes('restaurant')) notFound();

  let status: Awaited<ReturnType<typeof getPinStatus>>;
  try {
    status = await getPinStatus(ctx);
  } catch (error) {
    return <DataUnavailable error={error} />;
  }

  return <ApprovalPinForm scope={{ organizationSlug: ctx.organizationSlug, branchSlug: ctx.branchSlug }} hasPin={status.hasPin} />;
}
