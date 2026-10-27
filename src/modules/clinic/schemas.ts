import { z } from 'zod';

/**
 * Inputs for the clinic module (0111/0113). The ranges mirror the database
 * CHECKs so a form can show the error before the round trip; the database
 * remains the authority.
 */

const uuid = z.string().uuid();
const cents = z.coerce.number().int().nonnegative().max(1_000_000_000);
const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) => text(max).optional().transform((v) => (v ? v : undefined));
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'الوقت بصيغة HH:MM');
const commissionMode = z.enum(['percent', 'fixed', 'none']);

// ---- setup -------------------------------------------------------------------
export const settingsSchema = z
  .object({
    opensAt: time, closesAt: time,
    workDays: z.array(z.coerce.number().int().min(0).max(6)).min(1).max(7),
    slotMinutes: z.coerce.number().int().min(5).max(240),
    enforceShifts: z.boolean(),
    prescriptionLinkDays: z.coerce.number().int().min(1).max(365),
  })
  .refine((v) => v.closesAt > v.opensAt, { message: 'وقت الإغلاق بعد الفتح', path: ['closesAt'] });

export const roomSchema = z.object({
  id: uuid.nullable().optional(),
  name: text(80).min(1, 'اسم الغرفة مطلوب'),
  kind: z.enum(['consultation', 'procedure', 'imaging', 'lab', 'other']).default('consultation'),
  isActive: z.boolean().default(true),
});

export const doctorSchema = z
  .object({
    id: uuid.nullable().optional(),
    memberId: uuid.nullable().optional(),
    displayName: text(120).min(1, 'اسم الطبيب مطلوب'),
    specialty: optText(120),
    licenseNumber: optText(60),
    phone: optText(30),
    consultationFeeCents: cents.default(0),
    commissionMode: commissionMode.default('none'),
    commissionPercent: z.coerce.number().min(0).max(100).nullable().optional(),
    commissionFixedCents: cents.nullable().optional(),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    isActive: z.boolean().optional(),
    /** On create: give the doctor the clinic's default weekly shifts in the current branch. */
    defaultShifts: z.boolean().default(true),
  })
  .refine((v) => v.commissionMode !== 'percent' || v.commissionPercent != null, { message: 'النسبة مطلوبة', path: ['commissionPercent'] })
  .refine((v) => v.commissionMode !== 'fixed' || v.commissionFixedCents != null, { message: 'المبلغ مطلوب', path: ['commissionFixedCents'] });

export const shiftsSchema = z.object({
  doctorId: uuid,
  shifts: z
    .array(z.object({
      weekday: z.coerce.number().int().min(0).max(6),
      startsAt: time, endsAt: time,
      roomId: uuid.nullable().optional(),
      slotMinutes: z.coerce.number().int().min(5).max(240).default(15),
    }).refine((s) => s.endsAt > s.startsAt, { message: 'نهاية الفترة بعد بدايتها', path: ['endsAt'] }))
    .max(50),
});

export const serviceSchema = z.object({
  id: uuid.nullable().optional(),
  name: text(160).min(1, 'اسم الخدمة مطلوب'),
  code: optText(40),
  category: optText(80),
  priceCents: cents,
  durationMinutes: z.coerce.number().int().min(5).max(600).default(15),
  commissionMode: commissionMode.nullable().optional(),
  commissionPercent: z.coerce.number().min(0).max(100).nullable().optional(),
  commissionFixedCents: cents.nullable().optional(),
  isActive: z.boolean().optional(),
  /** Replaces the supply list when given. */
  supplies: z.array(z.object({ itemId: uuid, qty: z.coerce.number().positive().max(100000) })).max(100).optional(),
});

// ---- patients ----------------------------------------------------------------
export const patientSchema = z.object({
  id: uuid.nullable().optional(),
  fullName: text(160).min(1, 'اسم المريض مطلوب'),
  phone: optText(30),
  nationalId: optText(30),
  gender: z.enum(['male', 'female']).optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  bloodType: z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']).optional(),
  allergies: optText(2000),
  chronicConditions: optText(2000),
  emergencyContactName: optText(120),
  emergencyContactPhone: optText(30),
  notes: optText(2000),
});

// ---- calendar ----------------------------------------------------------------
export const bookSchema = z.object({
  patientId: uuid,
  doctorId: uuid,
  startsAt: z.string().datetime({ offset: true }),
  serviceIds: z.array(uuid).max(10).default([]),
  durationMinutes: z.coerce.number().int().min(5).max(720).optional(),
  roomId: uuid.nullable().optional(),
  reason: optText(300),
  source: z.enum(['staff', 'phone', 'walk_in', 'online']).default('staff'),
});

export const rescheduleSchema = z.object({
  appointmentId: uuid,
  startsAt: z.string().datetime({ offset: true }),
  doctorId: uuid.nullable().optional(),
  roomId: uuid.nullable().optional(),
  durationMinutes: z.coerce.number().int().min(5).max(720).optional(),
});

export const statusSchema = z
  .object({
    appointmentId: uuid,
    status: z.enum(['checked_in', 'in_session', 'completed', 'cancelled', 'no_show']),
    reason: optText(300),
  })
  .refine((v) => v.status !== 'cancelled' || !!v.reason, { message: 'سبب الإلغاء مطلوب', path: ['reason'] });

export const slotsSchema = z.object({ doctorId: uuid, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

export const addServiceSchema = z.object({
  appointmentId: uuid, serviceId: uuid,
  quantity: z.coerce.number().int().min(1).max(100).default(1),
  doctorId: uuid.nullable().optional(),
});
export const removeServiceSchema = z.object({ lineId: uuid });

// ---- EMR ---------------------------------------------------------------------
const vitals = z.object({
  temperatureC: z.coerce.number().min(30).max(45).optional(),
  pulseBpm: z.coerce.number().int().min(20).max(250).optional(),
  systolicMmhg: z.coerce.number().int().min(50).max(260).optional(),
  diastolicMmhg: z.coerce.number().int().min(30).max(160).optional(),
  respiratoryRate: z.coerce.number().int().min(5).max(80).optional(),
  spo2Percent: z.coerce.number().int().min(50).max(100).optional(),
  weightKg: z.coerce.number().min(0.3).max(400).optional(),
  heightCm: z.coerce.number().min(20).max(250).optional(),
  glucoseMgDl: z.coerce.number().int().min(10).max(1000).optional(),
})
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'أدخل قياسًا واحدًا على الأقل' })
  .refine((v) => v.systolicMmhg === undefined || v.diastolicMmhg === undefined || v.systolicMmhg > v.diastolicMmhg,
    { message: 'الانقباضي أعلى من الانبساطي', path: ['diastolicMmhg'] });

const emrBase = { patientId: uuid, appointmentId: uuid.nullable().optional(), title: optText(200) };

export const emrSchema = z.discriminatedUnion('type', [
  z.object({ ...emrBase, type: z.literal('note'), body: text(20000).min(1) }),
  z.object({ ...emrBase, type: z.literal('history'), body: text(20000).min(1) }),
  z.object({
    ...emrBase, type: z.literal('diagnosis'), body: optText(20000),
    diagnosisCode: z.string().trim().toUpperCase().regex(/^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/, 'رمز ICD-10 غير صالح').optional(),
  }),
  z.object({ ...emrBase, type: z.literal('vitals'), vitals }),
  z.object({
    ...emrBase, type: z.literal('attachment'), body: optText(20000),
    attachmentPath: z.string().max(400), attachmentMime: z.string().max(100), attachmentBytes: z.coerce.number().int().positive().max(20 * 1024 * 1024),
  }),
  z.object({ ...emrBase, type: z.literal('amendment'), amendsId: uuid, body: text(20000).min(1) }),
]);

// ---- prescriptions -----------------------------------------------------------
export const prescriptionIssueSchema = z.object({
  patientId: uuid,
  appointmentId: uuid.nullable().optional(),
  notes: optText(2000),
  items: z
    .array(z.object({
      drugName: text(160).min(1, 'اسم الدواء مطلوب'),
      strength: optText(60), dosageForm: optText(60), dose: optText(60), route: optText(40),
      frequency: optText(80), duration: optText(60), instructions: optText(500),
    }))
    .min(1, 'أضف دواءً واحدًا على الأقل')
    .max(30),
});
export const prescriptionCancelSchema = z.object({ prescriptionId: uuid, reason: text(300).min(1, 'سبب الإلغاء مطلوب') });
export const prescriptionShareSchema = z.object({ prescriptionId: uuid });

// ---- billing & commissions ---------------------------------------------------
export const visitInvoiceSchema = z.object({ appointmentId: uuid, discountCents: cents.default(0) });
export const visitPaySchema = z.object({
  appointmentId: uuid,
  method: z.enum(['cash', 'card', 'transfer', 'wallet', 'online', 'other']).default('cash'),
  tenderedCents: z.coerce.number().int().positive().max(1_000_000_000),
});
export const commissionSummarySchema = z.object({
  from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }),
  doctorId: uuid.nullable().optional(),
});
export const commissionPaySchema = z.object({ doctorId: uuid, until: z.string().datetime({ offset: true }).optional() });

export type SettingsInput = z.infer<typeof settingsSchema>;
export type RoomInput = z.infer<typeof roomSchema>;
export type DoctorInput = z.infer<typeof doctorSchema>;
export type ShiftsInput = z.infer<typeof shiftsSchema>;
export type ServiceInput = z.infer<typeof serviceSchema>;
export type PatientInput = z.infer<typeof patientSchema>;
export type BookInput = z.infer<typeof bookSchema>;
export type RescheduleInput = z.infer<typeof rescheduleSchema>;
export type StatusInput = z.infer<typeof statusSchema>;
export type AddServiceInput = z.infer<typeof addServiceSchema>;
export type EmrInput = z.infer<typeof emrSchema>;
export type PrescriptionIssueInput = z.infer<typeof prescriptionIssueSchema>;
export type VisitPayInput = z.infer<typeof visitPaySchema>;
export type CommissionSummaryInput = z.infer<typeof commissionSummarySchema>;

export const patientSearchSchema = z.object({ query: z.string().trim().min(2, 'اكتب حرفين على الأقل').max(60) });
