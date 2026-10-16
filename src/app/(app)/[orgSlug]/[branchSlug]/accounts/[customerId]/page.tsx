import { notFound } from 'next/navigation';
import { z } from 'zod';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { getStatement, listAccounts } from '@/modules/restaurant/crm/service';
import { DataUnavailable } from '@/components/patterns/data-unavailable';
import { StatementView } from './statement-view';

export const metadata = { title: 'كشف حساب' };
export const dynamic = 'force-dynamic';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const iso = (d: Date) => d.toISOString().slice(0, 10);

export default async function StatementPage({ params, searchParams }: {
  params: { orgSlug: string; branchSlug: string; customerId: string };
  searchParams: { from?: string; to?: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'restaurant.account.manage')) notFound();
  if (!z.string().uuid().safeParse(params.customerId).success) notFound();

  const now = new Date();
  const to = day.safeParse(searchParams.to).success ? searchParams.to! : iso(now);
  const from = day.safeParse(searchParams.from).success ? searchParams.from! : iso(new Date(now.getFullYear(), now.getMonth() - 2, 1));

  let statement; let account;
  try {
    const [s, all] = await Promise.all([getStatement(ctx, params.customerId, from, to), listAccounts(ctx)]);
    statement = s;
    account = all.find((a) => a.customerId === params.customerId) ?? null;
  } catch (error) {
    return <DataUnavailable error={error} />;
  }
  if (!account) notFound();

  return (
    <StatementView
      scope={{ organizationSlug: ctx.organizationSlug, branchSlug: ctx.branchSlug }}
      basePath={`/${ctx.organizationSlug}/${ctx.branchSlug}/accounts`}
      organizationName={ctx.organizationName}
      currency={ctx.currency}
      statement={statement}
      account={account}
    />
  );
}
