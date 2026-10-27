import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { getCalendar, getWorkspace } from '@/modules/clinic/service';
import { addDays, fromLocal, isLocalDate, todayIn, weekStart } from '@/modules/clinic/time';
import { ClinicCalendar } from './clinic-calendar';

export const metadata = { title: 'مواعيد العيادة' };

/**
 * The clinic calendar (0111/0113/0115): doctors side by side over their shift
 * hours, the week at a glance, today's waiting room, booking, shifts and the
 * visit cashier. The date and view live in the URL (?date=&view=&doctor=) so
 * a refresh or a shared link opens the same day.
 */
export default async function ClinicAppointmentsPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; branchSlug: string };
  searchParams: { date?: string; view?: string; doctor?: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  // Doctors may see their own calendar without holding the front desk's read.
  if (!can(ctx, 'clinic.appointment.read') && !can(ctx, 'clinic.emr.write')) notFound();

  const workspace = await getWorkspace(ctx);
  const tz = workspace.timezone;
  const today = todayIn(tz);
  const date = isLocalDate(searchParams.date) ? searchParams.date : today;
  const view = searchParams.view === 'week' ? 'week' : 'day';
  const rangeStart = view === 'week' ? weekStart(date) : date;
  const rangeDays = view === 'week' ? 7 : 1;

  const from = fromLocal(rangeStart, 0, tz);
  const to = fromLocal(addDays(rangeStart, rangeDays), 0, tz);
  const coversToday = today >= rangeStart && today < addDays(rangeStart, rangeDays);
  const todayFrom = fromLocal(today, 0, tz);
  const todayTo = fromLocal(addDays(today, 1), 0, tz);

  const [appointments, todays] = await Promise.all([
    getCalendar(ctx, from, to),
    coversToday ? Promise.resolve(null) : getCalendar(ctx, todayFrom, todayTo),
  ]);

  return (
    <ClinicCalendar
      scope={{ organizationSlug: ctx.organizationSlug, branchSlug: ctx.branchSlug }}
      currency={ctx.currency}
      workspace={workspace}
      view={view}
      date={date}
      rangeStart={rangeStart}
      today={today}
      doctorFilter={workspace.doctors.some((d) => d.id === searchParams.doctor) ? searchParams.doctor! : null}
      appointments={appointments}
      todaysAppointments={todays ?? appointments.filter((a) => {
        const t = Date.parse(a.startsAt);
        return t >= todayFrom.getTime() && t < todayTo.getTime();
      })}
      serverNow={new Date().toISOString()}
      permissions={{
        book: can(ctx, 'clinic.appointment.manage'),
        manageShifts: can(ctx, 'clinic.doctor.manage'),
        billing: can(ctx, 'clinic.billing.use'),
        clinical: can(ctx, 'clinic.emr.write'),
        createPatient: can(ctx, 'clinic.patient.manage'),
        readPatients: can(ctx, 'clinic.patient.read'),
      }}
    />
  );
}
