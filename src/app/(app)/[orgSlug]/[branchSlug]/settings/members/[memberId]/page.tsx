import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getStaffPerformance } from '@/modules/restaurant/orders/staff';
import { formatDuration, monthStartFrom, shiftMonth } from '@/modules/restaurant/orders/staff-metrics';
import { PageHeader } from '@/components/patterns/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Money } from '@/components/patterns/money';
import { EmptyState } from '@/components/patterns/states';

export const metadata = { title: 'أداء الموظف' };
export const dynamic = 'force-dynamic';

const NUM = new Intl.NumberFormat('ar-EG');

function Stat({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded border border-line bg-elevated p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="lb-numeric mt-1 text-xl font-bold text-fg">{children}</p>
      {hint && <p className="mt-1 text-[11px] text-muted">{hint}</p>}
    </div>
  );
}

/**
 * One employee's profile and their month: what they handled, how fast the
 * kitchen side was, and what the till side took in. Everything comes from the
 * order audit trail via restaurant_staff_performance (0089), which re-checks
 * report.read / member.manage per branch itself.
 */
export default async function StaffProfilePage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; branchSlug: string; memberId: string };
  searchParams: { month?: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'member.read')) notFound();
  if (!can(ctx, 'report.read') && !can(ctx, 'member.manage')) notFound();

  const supabase = createSupabaseServerClient();
  const { data: member } = await supabase
    .from('organization_members')
    .select('id, user_id, status, all_branches')
    .eq('organization_id', ctx.organizationId)
    .eq('id', params.memberId)
    .maybeSingle();
  if (!member) notFound();

  const [{ data: profile }, { data: grants }] = await Promise.all([
    supabase.from('profiles').select('full_name, phone, username').eq('id', member.user_id).maybeSingle(),
    supabase.from('user_roles').select('roles!inner(name_ar)').eq('member_id', member.id),
  ]);
  const roleNames = (grants ?? []).map((g) => (g.roles as unknown as { name_ar: string } | null)?.name_ar).filter(Boolean);

  const monthStart = monthStartFrom(searchParams.month);
  const perf = await getStaffPerformance(ctx, member.user_id, monthStart);
  const t = perf.totals;
  const base = `/${ctx.organizationSlug}/${ctx.branchSlug}/settings/members/${member.id}`;
  const monthLabel = new Date(`${monthStart}T12:00:00Z`).toLocaleDateString('ar-EG', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });

  const hasKitchen = t.prepared > 0;
  const hasTill = t.paid > 0 || t.collected_cents > 0;
  const hasFloor = t.created > 0 || t.served > 0;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <Link href={`/${ctx.organizationSlug}/${ctx.branchSlug}/settings/members`}>
        <Button variant="ghost" size="sm">
          <ArrowRight className="h-4 w-4 lb-flip" aria-hidden="true" />
          فريق العمل
        </Button>
      </Link>

      <PageHeader
        title={profile?.full_name ?? 'موظف'}
        description={[profile?.username ? `@${profile.username}` : null, profile?.phone].filter(Boolean).join(' · ')}
        actions={
          <span className="flex flex-wrap gap-1">
            {roleNames.map((r, i) => <Badge key={i} tone="info">{r}</Badge>)}
            <Badge tone={member.status === 'active' ? 'success' : 'neutral'}>
              {member.status === 'active' ? 'نشط' : member.status}
            </Badge>
          </span>
        }
      />

      <Card data-testid="monthly-performance">
        <CardHeader>
          <div className="flex w-full items-center justify-between gap-3">
            <CardTitle>تحليل الأداء الشهري</CardTitle>
            <nav aria-label="الشهر" className="flex items-center gap-1 text-sm">
              <Link href={`${base}?month=${shiftMonth(monthStart, -1)}`} aria-label="الشهر السابق"
                className="rounded p-1.5 hover:bg-surface">
                <ChevronRight className="h-4 w-4 lb-flip" aria-hidden="true" />
              </Link>
              <span className="min-w-28 text-center font-semibold">{monthLabel}</span>
              <Link href={`${base}?month=${shiftMonth(monthStart, 1)}`} aria-label="الشهر التالي"
                className="rounded p-1.5 hover:bg-surface">
                <ChevronLeft className="h-4 w-4 lb-flip" aria-hidden="true" />
              </Link>
            </nav>
          </div>
        </CardHeader>
        <CardBody className="space-y-5">
          {t.handled === 0 ? (
            <EmptyState title="لا يوجد نشاط على الطلبات في هذا الشهر" />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="إجمالي الطلبات التي تعامل معها">{NUM.format(t.handled)}</Stat>
                {hasKitchen && (
                  <>
                    <Stat label="طلبات أنهى تحضيرها">{NUM.format(t.prepared)}</Stat>
                    <Stat
                      label="متوسط زمن التحضير للطلب"
                      hint={t.prep_outliers > 0
                        ? `لم تُحتسب ${NUM.format(t.prep_outliers)} تذكرة بقيت مفتوحة أكثر من ٤ ساعات`
                        : undefined}
                    >
                      {formatDuration(t.avg_prep_seconds)}
                    </Stat>
                  </>
                )}
                {hasTill && (
                  <>
                    <Stat label="طلبات حصّل دفعها">{NUM.format(t.paid)}</Stat>
                    <Stat label="إجمالي المبالغ المحصّلة">
                      <Money cents={t.collected_cents} currency={ctx.currency} />
                    </Stat>
                  </>
                )}
                {hasFloor && (
                  <>
                    <Stat label="طلبات استلمها / أنشأها">{NUM.format(t.created)}</Stat>
                    <Stat label="مبيعات الطلبات التي أنشأها">
                      <Money cents={t.created_sales_cents} currency={ctx.currency} />
                    </Stat>
                    <Stat label="طلبات قدّمها">{NUM.format(t.served)}</Stat>
                  </>
                )}
              </div>

              <div>
                <h3 className="mb-2 text-sm font-bold">التوزيع اليومي</h3>
                <div className="overflow-x-auto rounded border border-line">
                  <table className="w-full text-sm">
                    <caption className="sr-only">الطلبات التي تعامل معها الموظف يوميًا</caption>
                    <thead>
                      <tr className="border-b border-line bg-surface text-xs text-muted">
                        <th scope="col" className="p-2.5 text-start font-medium">اليوم</th>
                        <th scope="col" className="p-2.5 text-start font-medium">الطلبات</th>
                        {hasFloor && <th scope="col" className="p-2.5 text-start font-medium">استلم / قدّم</th>}
                        {hasKitchen && <th scope="col" className="p-2.5 text-start font-medium">حضّر</th>}
                        {hasKitchen && <th scope="col" className="p-2.5 text-start font-medium">متوسط التحضير</th>}
                        {hasTill && <th scope="col" className="p-2.5 text-start font-medium">حصّل</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {perf.days.map((d) => (
                        <tr key={d.day} className="border-b border-line last:border-0">
                          <td className="p-2.5">
                            {new Date(`${d.day}T12:00:00Z`).toLocaleDateString('ar-EG', {
                              weekday: 'long', day: 'numeric', month: 'numeric', timeZone: 'UTC',
                            })}
                          </td>
                          <td className="lb-numeric p-2.5 font-semibold">{NUM.format(d.handled)}</td>
                          {hasFloor && (
                            <td className="lb-numeric p-2.5">{NUM.format(d.created)} / {NUM.format(d.served)}</td>
                          )}
                          {hasKitchen && <td className="lb-numeric p-2.5">{NUM.format(d.prepared)}</td>}
                          {hasKitchen && (
                            <td className="lb-numeric p-2.5">{formatDuration(d.avg_prep_seconds)}</td>
                          )}
                          {hasTill && (
                            <td className="p-2.5">
                              <Money cents={d.collected_cents} currency={ctx.currency} />
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-xs text-muted">
                  اليوم محسوب بتوقيت المنشأة ({perf.timezone}). لا توجد ورديات مسجّلة في النظام، فالتوزيع يومي.
                </p>
              </div>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
