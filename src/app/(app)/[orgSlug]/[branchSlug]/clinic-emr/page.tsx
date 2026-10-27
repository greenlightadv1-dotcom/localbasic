import { notFound } from 'next/navigation';
import { resolveTenantContext, can } from '@/modules/core/tenancy/context';
import { getCalendar, getPatientChart, getWorkspace } from '@/modules/clinic/service';
import { addDays, fromLocal, todayIn } from '@/modules/clinic/time';
import { EmrWorkspace } from './emr-workspace';

export const metadata = { title: 'الملف الطبي' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The medical record (0111/0113/0116). Clinical staff only: the page needs
 * clinic.emr.read, and the chart read checks it again in the database.
 *
 * ?patient= opens a chart. Without it, the page lists today's patients in
 * this branch, waiting and in session first, and offers search.
 */
export default async function ClinicEmrPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; branchSlug: string };
  searchParams: { patient?: string };
}) {
  const ctx = await resolveTenantContext(params.orgSlug, params.branchSlug);
  if (!can(ctx, 'clinic.emr.read')) notFound();

  const workspace = await getWorkspace(ctx);
  const tz = workspace.timezone;
  const today = todayIn(tz);
  const patientId = searchParams.patient && UUID.test(searchParams.patient) ? searchParams.patient : null;

  const [chart, todays] = await Promise.all([
    patientId ? getPatientChart(ctx, patientId) : Promise.resolve(null),
    getCalendar(ctx, fromLocal(today, 0, tz), fromLocal(addDays(today, 1), 0, tz)),
  ]);

  return (
    <EmrWorkspace
      scope={{ organizationSlug: ctx.organizationSlug, branchSlug: ctx.branchSlug }}
      organizationId={ctx.organizationId}
      currency={ctx.currency}
      workspace={workspace}
      chart={chart}
      requestedPatientId={patientId}
      todays={todays}
      permissions={{
        write: can(ctx, 'clinic.emr.write'),
        prescribe: can(ctx, 'clinic.prescription.write') && workspace.myDoctorId !== null,
        prescriptionWrite: can(ctx, 'clinic.prescription.write'),
        editPatient: can(ctx, 'clinic.patient.manage'),
        searchPatients: can(ctx, 'clinic.patient.read'),
        manageDoctors: can(ctx, 'clinic.doctor.manage'),
      }}
    />
  );
}
