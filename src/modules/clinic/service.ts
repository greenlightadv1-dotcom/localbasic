import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { staffDbError, toAppError } from '@/lib/errors';
import { appOrigin } from '@/lib/auth/redirects';
import type { TenantContext } from '@/modules/core/tenancy/context';
import type {
  AddServiceInput,
  BookInput,
  CommissionSummaryInput,
  DoctorInput,
  EmrInput,
  PatientInput,
  PrescriptionIssueInput,
  RescheduleInput,
  RoomInput,
  ServiceInput,
  SettingsInput,
  ShiftsInput,
  StatusInput,
  VisitPayInput,
} from './schemas';

/**
 * Clinic module (0111/0113). The module key is 'medical'; "clinic" is the
 * product name. Each function is one call into a SECURITY DEFINER function
 * that re-checks permission and tenancy; audit lines name records, never
 * their medical content.
 *
 * Database answers the screens handle on purpose:
 *   LB409  the doctor or room is taken (or shifts overlap) → reload the calendar
 *   LB403  a discount needs a manager's PIN                → approval dialog
 */

type Row = Record<string, unknown>;

async function call(fn: string, args: Record<string, unknown>, context: string): Promise<unknown> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc(fn as never, args as never);
  if (error) throw staffDbError(error, context);
  return data;
}

const rows = (data: unknown): Row[] => (Array.isArray(data) ? (data as Row[]) : data ? [data as Row] : []);
const num = (v: unknown) => Number(v ?? 0);
const orNull = <T>(v: T | undefined | '') => (v === undefined || v === '' ? null : v);

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
export async function saveSettings(ctx: TenantContext, input: SettingsInput): Promise<void> {
  await call('clinic_settings_save', {
    p_org: ctx.organizationId,
    p_data: {
      opens_at: input.opensAt, closes_at: input.closesAt, work_days: input.workDays, slot_minutes: input.slotMinutes,
      enforce_shifts: input.enforceShifts, prescription_link_days: input.prescriptionLinkDays,
    },
  }, 'clinic.saveSettings');
}

export async function saveRoom(ctx: TenantContext, input: RoomInput): Promise<string> {
  return String(await call('clinic_room_save', {
    p_org: ctx.organizationId, p_branch: ctx.branchId, p_id: input.id ?? null,
    p_name: input.name, p_kind: input.kind, p_active: input.isActive,
  }, 'clinic.saveRoom'));
}

export async function saveDoctor(ctx: TenantContext, input: DoctorInput): Promise<string> {
  return String(await call('clinic_doctor_save', {
    p_org: ctx.organizationId, p_id: input.id ?? null,
    p_data: {
      member_id: input.memberId ?? null, display_name: input.displayName, specialty: orNull(input.specialty),
      license_number: orNull(input.licenseNumber), phone: orNull(input.phone),
      consultation_fee_cents: input.consultationFeeCents, commission_mode: input.commissionMode,
      commission_percent: input.commissionPercent ?? null, commission_fixed_cents: input.commissionFixedCents ?? null,
      color: orNull(input.color), is_active: input.isActive ?? null,
      branch_id: !input.id && input.defaultShifts ? ctx.branchId : null,
    },
  }, 'clinic.saveDoctor'));
}

export async function setShifts(ctx: TenantContext, input: ShiftsInput): Promise<number> {
  return num(await call('clinic_doctor_set_shifts', {
    p_org: ctx.organizationId, p_doctor: input.doctorId, p_branch: ctx.branchId,
    p_shifts: input.shifts.map((s) => ({
      weekday: s.weekday, starts_at: s.startsAt, ends_at: s.endsAt, room_id: s.roomId ?? null, slot_minutes: s.slotMinutes,
    })),
  }, 'clinic.setShifts'));
}

export async function saveService(ctx: TenantContext, input: ServiceInput): Promise<string> {
  return String(await call('clinic_service_save', {
    p_org: ctx.organizationId, p_id: input.id ?? null,
    p_data: {
      name: input.name, code: orNull(input.code), category: orNull(input.category), price_cents: input.priceCents,
      duration_minutes: input.durationMinutes, commission_mode: input.commissionMode ?? null,
      commission_percent: input.commissionPercent ?? null, commission_fixed_cents: input.commissionFixedCents ?? null,
      is_active: input.isActive ?? null,
    },
    p_supplies: input.supplies?.map((s) => ({ item_id: s.itemId, qty: s.qty })) ?? null,
  }, 'clinic.saveService'));
}

// ---------------------------------------------------------------------------
// Patients
// ---------------------------------------------------------------------------
export async function savePatient(ctx: TenantContext, input: PatientInput): Promise<string> {
  return String(await call('clinic_patient_save', {
    p_org: ctx.organizationId, p_branch: ctx.branchId, p_id: input.id ?? null,
    p_data: {
      full_name: input.fullName, phone: orNull(input.phone), national_id: orNull(input.nationalId),
      gender: orNull(input.gender), date_of_birth: orNull(input.dateOfBirth), blood_type: orNull(input.bloodType),
      allergies: orNull(input.allergies), chronic_conditions: orNull(input.chronicConditions),
      emergency_contact_name: orNull(input.emergencyContactName), emergency_contact_phone: orNull(input.emergencyContactPhone),
      notes: orNull(input.notes),
    },
  }, 'clinic.savePatient'));
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------
export async function bookAppointment(ctx: TenantContext, input: BookInput): Promise<string> {
  return String(await call('clinic_appointment_book', {
    p_org: ctx.organizationId, p_branch: ctx.branchId, p_patient: input.patientId, p_doctor: input.doctorId,
    p_starts_at: input.startsAt, p_services: input.serviceIds, p_duration_minutes: input.durationMinutes ?? null,
    p_room: input.roomId ?? null, p_reason: orNull(input.reason), p_source: input.source,
  }, 'clinic.book'));
}

export async function rescheduleAppointment(ctx: TenantContext, input: RescheduleInput): Promise<void> {
  await call('clinic_appointment_reschedule', {
    p_org: ctx.organizationId, p_appointment: input.appointmentId, p_starts_at: input.startsAt,
    p_doctor: input.doctorId ?? null, p_room: input.roomId ?? null, p_duration_minutes: input.durationMinutes ?? null,
  }, 'clinic.reschedule');
}

/** Completing a visit consumes its supplies, accrues commission and issues the invoice — all in the database. */
export async function setAppointmentStatus(ctx: TenantContext, input: StatusInput): Promise<void> {
  await call('clinic_appointment_set_status', {
    p_org: ctx.organizationId, p_appointment: input.appointmentId, p_status: input.status, p_reason: orNull(input.reason),
  }, 'clinic.setStatus');
}

export type Slot = { startsAt: string; endsAt: string; roomId: string | null };

export async function getAvailableSlots(ctx: TenantContext, doctorId: string, date: string): Promise<Slot[]> {
  const data = await call('clinic_available_slots', {
    p_org: ctx.organizationId, p_branch: ctx.branchId, p_doctor: doctorId, p_date: date,
  }, 'clinic.slots');
  return rows(data).map((r) => ({ startsAt: String(r.starts_at), endsAt: String(r.ends_at), roomId: (r.room_id as string) ?? null }));
}

export async function addVisitService(ctx: TenantContext, input: AddServiceInput): Promise<string> {
  return String(await call('clinic_appointment_add_service', {
    p_org: ctx.organizationId, p_appointment: input.appointmentId, p_service: input.serviceId,
    p_quantity: input.quantity, p_doctor: input.doctorId ?? null,
  }, 'clinic.addService'));
}

export async function removeVisitService(ctx: TenantContext, lineId: string): Promise<void> {
  await call('clinic_appointment_remove_service', { p_org: ctx.organizationId, p_line: lineId }, 'clinic.removeService');
}

// ---------------------------------------------------------------------------
// EMR
// ---------------------------------------------------------------------------
export async function addEmrRecord(ctx: TenantContext, input: EmrInput): Promise<string> {
  const data: Record<string, unknown> = { title: input.title ?? null };
  switch (input.type) {
    case 'note':
    case 'history':
      data.body = input.body; break;
    case 'diagnosis':
      data.body = input.body ?? null; data.diagnosis_code = input.diagnosisCode ?? null; break;
    case 'vitals':
      Object.assign(data, {
        temperature_c: input.vitals.temperatureC, pulse_bpm: input.vitals.pulseBpm,
        systolic_mmhg: input.vitals.systolicMmhg, diastolic_mmhg: input.vitals.diastolicMmhg,
        respiratory_rate: input.vitals.respiratoryRate, spo2_percent: input.vitals.spo2Percent,
        weight_kg: input.vitals.weightKg, height_cm: input.vitals.heightCm, glucose_mg_dl: input.vitals.glucoseMgDl,
      });
      break;
    case 'attachment':
      Object.assign(data, {
        body: input.body ?? null, attachment_path: input.attachmentPath,
        attachment_mime: input.attachmentMime, attachment_bytes: input.attachmentBytes,
      });
      break;
    case 'amendment':
      data.body = input.body; data.amends_id = input.amendsId; break;
  }
  return String(await call('clinic_emr_add', {
    p_org: ctx.organizationId, p_patient: input.patientId, p_type: input.type, p_data: data,
    p_appointment: input.appointmentId ?? null,
  }, 'clinic.emrAdd'));
}

/** Where an attachment must be uploaded (private 'clinic-records' bucket) before clinic_emr_add records it. */
export function attachmentPath(ctx: TenantContext, patientId: string, fileName: string): string {
  const safe = fileName.normalize('NFKC').replace(/[^\w.\-]+/g, '_').slice(-80);
  return `${ctx.organizationId}/${patientId}/${crypto.randomUUID()}-${safe}`;
}

// ---------------------------------------------------------------------------
// Prescriptions
// ---------------------------------------------------------------------------
export type IssuedPrescription = { id: string; number: string; token: string; expiresAt: string };

export async function issuePrescription(ctx: TenantContext, input: PrescriptionIssueInput): Promise<IssuedPrescription> {
  const [r] = rows(await call('clinic_prescription_issue', {
    p_org: ctx.organizationId, p_patient: input.patientId, p_appointment: input.appointmentId ?? null,
    p_notes: orNull(input.notes),
    p_items: input.items.map((i) => ({
      drug_name: i.drugName, strength: orNull(i.strength), dosage_form: orNull(i.dosageForm), dose: orNull(i.dose),
      route: orNull(i.route), frequency: orNull(i.frequency), duration: orNull(i.duration), instructions: orNull(i.instructions),
    })),
  }, 'clinic.issuePrescription'));
  return { id: String(r!.out_id), number: String(r!.out_number), token: String(r!.out_token), expiresAt: String(r!.out_expires_at) };
}

export async function cancelPrescription(ctx: TenantContext, prescriptionId: string, reason: string): Promise<void> {
  await call('clinic_prescription_cancel', { p_org: ctx.organizationId, p_prescription: prescriptionId, p_reason: reason }, 'clinic.cancelPrescription');
}

/** A fresh link (the old one stops working) and a ready wa.me URL when the patient has a phone. */
export async function sharePrescription(
  ctx: TenantContext, prescriptionId: string,
): Promise<{ url: string; expiresAt: string; whatsappUrl: string | null }> {
  const [r] = rows(await call('clinic_prescription_share', { p_org: ctx.organizationId, p_prescription: prescriptionId }, 'clinic.sharePrescription'));
  const url = `${appOrigin()}/rx/${encodeURIComponent(String(r!.out_token))}`;
  const digits = String(r!.out_patient_phone ?? '').replace(/\D/g, '');
  const intl = digits.startsWith('0') ? `20${digits.slice(1)}` : digits;
  const message = `روشتة ${String(r!.out_number)}: ${url}`;
  return {
    url, expiresAt: String(r!.out_expires_at),
    whatsappUrl: intl.length >= 10 ? `https://wa.me/${intl}?text=${encodeURIComponent(message)}` : null,
  };
}

export type PublicPrescription = {
  number: string; issued_at: string; expires_at: string; notes: string | null;
  clinic: string; branch: string; branch_phone: string | null; branch_address: string | null;
  doctor: string; specialty: string | null; license: string | null;
  patient: string; file_number: string; age: number | null;
  items: { drug_name: string; strength: string | null; dosage_form: string | null; dose: string | null;
           route: string | null; frequency: string | null; duration: string | null; instructions: string | null }[];
};

/** The anonymous read behind /rx/[token]. null = unknown, cancelled or expired. */
export async function getPublicPrescription(token: string): Promise<PublicPrescription | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('clinic_prescription_public' as never, { p_token: token } as never);
  if (error) throw toAppError(error, 'clinic.publicPrescription');
  return (data as PublicPrescription | null) ?? null;
}

// ---------------------------------------------------------------------------
// Billing and commissions
// ---------------------------------------------------------------------------
export async function invoiceVisit(ctx: TenantContext, appointmentId: string, discountCents: number): Promise<string> {
  return String(await call('clinic_visit_invoice', {
    p_org: ctx.organizationId, p_appointment: appointmentId, p_discount_cents: discountCents,
  }, 'clinic.invoiceVisit'));
}

export type VisitPayment = {
  invoiceId: string; invoiceNumber: string; totalCents: number; paidCents: number; changeCents: number; dueCents: number;
};

export async function payVisit(ctx: TenantContext, input: VisitPayInput): Promise<VisitPayment> {
  const [r] = rows(await call('clinic_visit_pay', {
    p_org: ctx.organizationId, p_appointment: input.appointmentId, p_method: input.method, p_tendered_cents: input.tenderedCents,
  }, 'clinic.payVisit'));
  return {
    invoiceId: String(r!.out_invoice_id), invoiceNumber: String(r!.out_invoice_number), totalCents: num(r!.out_total_cents),
    paidCents: num(r!.out_paid_cents), changeCents: num(r!.out_change_cents), dueCents: num(r!.out_due_cents),
  };
}

export type CommissionRow = {
  doctorId: string; doctorName: string; lines: number; baseCents: number; commissionCents: number; unpaidCents: number;
};

/** Without clinic.commission.read the database narrows this to the caller's own doctor row. */
export async function getCommissionSummary(ctx: TenantContext, input: CommissionSummaryInput): Promise<CommissionRow[]> {
  const data = await call('clinic_commission_summary', {
    p_org: ctx.organizationId, p_from: input.from, p_to: input.to, p_doctor: input.doctorId ?? null,
  }, 'clinic.commissionSummary');
  return rows(data).map((r) => ({
    doctorId: String(r.doctor_id), doctorName: String(r.doctor_name), lines: num(r.lines),
    baseCents: num(r.base_cents), commissionCents: num(r.commission_cents), unpaidCents: num(r.unpaid_cents),
  }));
}

export async function payCommission(ctx: TenantContext, doctorId: string, until?: string): Promise<number> {
  return num(await call('clinic_commission_pay', {
    p_org: ctx.organizationId, p_branch: ctx.branchId, p_doctor: doctorId, p_until: until ?? new Date().toISOString(),
  }, 'clinic.payCommission'));
}

// ---------------------------------------------------------------------------
// Calendar reads (0115)
// ---------------------------------------------------------------------------
export type AppointmentStatus = 'booked' | 'checked_in' | 'in_session' | 'completed' | 'cancelled' | 'no_show';

export type ClinicWorkspace = {
  branchModule: string | null;
  timezone: string;
  myDoctorId: string | null;
  settings: { opensAt: string; closesAt: string; workDays: number[]; slotMinutes: number; enforceShifts: boolean };
  doctors: { id: string; name: string; specialty: string | null; color: string | null; feeCents: number; isMe: boolean }[];
  rooms: { id: string; name: string; kind: string }[];
  services: { id: string; name: string; category: string | null; priceCents: number; durationMinutes: number }[];
  shifts: { id: string; doctorId: string; roomId: string | null; weekday: number; startsAt: string; endsAt: string; slotMinutes: number }[];
};

export type CalendarAppointment = {
  id: string;
  doctorId: string;
  roomId: string | null;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  source: string;
  reason: string | null;
  checkedInAt: string | null;
  sessionStartedAt: string | null;
  completedAt: string | null;
  cancelReason: string | null;
  patient: { id: string; name: string; fileNumber: string; phone: string | null; allergies: string | null };
  services: { lineId: string; serviceId: string; name: string; doctorId: string; quantity: number; unitPriceCents: number; discountCents: number; consumed: boolean }[];
  invoice: { id: string; number: string; totalCents: number; paidCents: number; status: string } | null;
};

export type PatientHit = {
  id: string; fileNumber: string; name: string; phone: string | null;
  gender: string | null; dateOfBirth: string | null; allergies: string | null;
};

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

export async function getWorkspace(ctx: TenantContext): Promise<ClinicWorkspace> {
  const w = (await call('clinic_workspace', { p_org: ctx.organizationId, p_branch: ctx.branchId }, 'clinic.workspace')) as Row;
  const s = (w.settings ?? {}) as Row;
  return {
    branchModule: str(w.branch_module),
    timezone: str(w.timezone) ?? ctx.timezone,
    myDoctorId: str(w.my_doctor_id),
    settings: {
      opensAt: String(s.opens_at ?? '09:00'), closesAt: String(s.closes_at ?? '21:00'),
      workDays: ((s.work_days as number[]) ?? []).map(Number), slotMinutes: num(s.slot_minutes) || 15,
      enforceShifts: Boolean(s.enforce_shifts),
    },
    doctors: ((w.doctors as Row[]) ?? []).map((d) => ({
      id: String(d.id), name: String(d.display_name), specialty: str(d.specialty), color: str(d.color),
      feeCents: num(d.consultation_fee_cents), isMe: Boolean(d.is_me),
    })),
    rooms: ((w.rooms as Row[]) ?? []).map((r) => ({ id: String(r.id), name: String(r.name), kind: String(r.kind) })),
    services: ((w.services as Row[]) ?? []).map((x) => ({
      id: String(x.id), name: String(x.name), category: str(x.category), priceCents: num(x.price_cents), durationMinutes: num(x.duration_minutes),
    })),
    shifts: ((w.shifts as Row[]) ?? []).map((x) => ({
      id: String(x.id), doctorId: String(x.doctor_id), roomId: str(x.room_id), weekday: num(x.weekday),
      startsAt: String(x.starts_at), endsAt: String(x.ends_at), slotMinutes: num(x.slot_minutes) || 15,
    })),
  };
}

export async function getCalendar(ctx: TenantContext, from: Date, to: Date): Promise<CalendarAppointment[]> {
  const data = await call('clinic_calendar', {
    p_org: ctx.organizationId, p_branch: ctx.branchId, p_from: from.toISOString(), p_to: to.toISOString(),
  }, 'clinic.calendar');
  return ((data as Row[]) ?? []).map((a) => {
    const p = (a.patient ?? {}) as Row;
    const inv = a.invoice as Row | null;
    return {
      id: String(a.id), doctorId: String(a.doctor_id), roomId: str(a.room_id),
      startsAt: String(a.starts_at), endsAt: String(a.ends_at), status: a.status as AppointmentStatus,
      source: String(a.source), reason: str(a.reason), checkedInAt: str(a.checked_in_at),
      sessionStartedAt: str(a.session_started_at), completedAt: str(a.completed_at), cancelReason: str(a.cancel_reason),
      patient: { id: String(p.id), name: String(p.full_name), fileNumber: String(p.file_number), phone: str(p.phone), allergies: str(p.allergies) },
      services: ((a.services as Row[]) ?? []).map((l) => ({
        lineId: String(l.line_id), serviceId: String(l.service_id), name: String(l.name), doctorId: String(l.doctor_id),
        quantity: num(l.quantity), unitPriceCents: num(l.unit_price_cents), discountCents: num(l.discount_cents), consumed: Boolean(l.consumed),
      })),
      invoice: inv ? { id: String(inv.id), number: String(inv.number), totalCents: num(inv.total_cents), paidCents: num(inv.paid_cents), status: String(inv.status) } : null,
    };
  });
}

export async function searchPatients(ctx: TenantContext, query: string): Promise<PatientHit[]> {
  const data = await call('clinic_patient_search', { p_org: ctx.organizationId, p_query: query }, 'clinic.patientSearch');
  return rows(data).map((r) => ({
    id: String(r.id), fileNumber: String(r.file_number), name: String(r.full_name), phone: str(r.phone),
    gender: str(r.gender), dateOfBirth: str(r.date_of_birth), allergies: str(r.allergies),
  }));
}
