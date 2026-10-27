import type { AppointmentStatus } from '@/modules/clinic/service';

export type Scope = { organizationSlug: string; branchSlug: string };

export type ClinicPermissions = {
  /** clinic.appointment.manage: book, check in, cancel, reschedule */
  book: boolean;
  /** clinic.doctor.manage: shifts and doctors */
  manageShifts: boolean;
  /** clinic.billing.use: invoice and take payment */
  billing: boolean;
  /** clinic.emr.write: start and complete a session */
  clinical: boolean;
  /** clinic.patient.manage: register a patient */
  createPatient: boolean;
  /** clinic.patient.read: search patients */
  readPatients: boolean;
};

export const STATUS_META: Record<AppointmentStatus, { label: string; tone: 'neutral' | 'info' | 'success' | 'warn' | 'danger'; block: string }> = {
  booked: { label: 'محجوز', tone: 'info', block: 'border-primary/40 bg-primary-soft text-primary' },
  checked_in: { label: 'وصل — في الانتظار', tone: 'warn', block: 'border-warn/50 bg-warn/10 text-warn' },
  in_session: { label: 'في الكشف', tone: 'success', block: 'border-success/60 bg-success/15 text-success' },
  completed: { label: 'انتهى', tone: 'neutral', block: 'border-line bg-surface text-muted' },
  cancelled: { label: 'ملغي', tone: 'danger', block: 'border-danger/30 bg-danger/5 text-danger line-through' },
  no_show: { label: 'لم يحضر', tone: 'danger', block: 'border-danger/30 bg-danger/5 text-danger' },
};

export const ACTIVE: AppointmentStatus[] = ['booked', 'checked_in', 'in_session'];

export const SOURCE_LABELS: Record<string, string> = { staff: 'الاستقبال', phone: 'هاتف', walk_in: 'حضور مباشر', online: 'أونلاين' };

/** Clinic week order, Saturday first. */
export const WEEK_ORDER = [6, 0, 1, 2, 3, 4, 5] as const;

/** A friendly message for an action failure, keeping the database's own wording when it gave one. */
export function failure(r: { code: string; error: string }): string {
  if (r.code === 'forbidden' || r.code === 'not_found') return 'لا تملك صلاحية هذا الإجراء.';
  return r.error;
}
