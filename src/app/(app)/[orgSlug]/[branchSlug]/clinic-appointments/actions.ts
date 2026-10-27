'use server';

import { revalidatePath } from 'next/cache';
import { defineTenantAction } from '@/lib/action';
import * as schemas from '@/modules/clinic/schemas';
import * as clinic from '@/modules/clinic/service';

/**
 * Front desk, calendar, clinic setup and the visit cashier (0111/0113).
 *
 * A slot conflict comes back as a validation error carrying the database's
 * own message (LB409); the calendar reloads. A visit discount comes back as
 * `approval` (LB403 'order.discount') for the manager-PIN dialog.
 */
type Scope = { organizationSlug: string; branchSlug: string };
const path = (ctx: Scope) => `/${ctx.organizationSlug}/${ctx.branchSlug}/clinic-appointments`;
const done = <T>(ctx: Scope, value: T) => { revalidatePath(path(ctx)); return value; };
const ok = { ok: true as const };

// ---- setup -------------------------------------------------------------------
export const saveClinicSettingsAction = defineTenantAction({
  schema: schemas.settingsSchema, permission: 'clinic.doctor.manage',
  handler: async ({ ctx, input }) => done(ctx, (await clinic.saveSettings(ctx, input), ok)),
});

export const saveRoomAction = defineTenantAction({
  schema: schemas.roomSchema, permission: 'clinic.doctor.manage',
  handler: async ({ ctx, input }) => done(ctx, { id: await clinic.saveRoom(ctx, input) }),
});

export const saveDoctorAction = defineTenantAction({
  schema: schemas.doctorSchema, permission: 'clinic.doctor.manage',
  handler: async ({ ctx, input }) => done(ctx, { id: await clinic.saveDoctor(ctx, input) }),
});

export const setShiftsAction = defineTenantAction({
  schema: schemas.shiftsSchema, permission: 'clinic.doctor.manage',
  handler: async ({ ctx, input }) => done(ctx, { count: await clinic.setShifts(ctx, input) }),
});

export const saveServiceAction = defineTenantAction({
  schema: schemas.serviceSchema, permission: 'clinic.service.manage',
  handler: async ({ ctx, input }) => done(ctx, { id: await clinic.saveService(ctx, input) }),
});

// ---- patients and calendar -------------------------------------------------------
export const savePatientAction = defineTenantAction({
  schema: schemas.patientSchema, permission: 'clinic.patient.manage',
  handler: async ({ ctx, input }) => done(ctx, { id: await clinic.savePatient(ctx, input) }),
});

export const bookAppointmentAction = defineTenantAction({
  schema: schemas.bookSchema, permission: 'clinic.appointment.manage',
  rateLimit: { limit: 120, windowMs: 60_000 },
  handler: async ({ ctx, input }) => done(ctx, { id: await clinic.bookAppointment(ctx, input) }),
});

export const rescheduleAppointmentAction = defineTenantAction({
  schema: schemas.rescheduleSchema, permission: 'clinic.appointment.manage',
  handler: async ({ ctx, input }) => done(ctx, (await clinic.rescheduleAppointment(ctx, input), ok)),
});

// Front desk checks in and cancels; clinical staff start and complete. The
// database applies that split, so the gate here is only "on the clinic team".
export const setAppointmentStatusAction = defineTenantAction({
  schema: schemas.statusSchema, permission: 'clinic.appointment.read',
  handler: async ({ ctx, input }) => {
    await clinic.setAppointmentStatus(ctx, input);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/clinic-emr`);
    return done(ctx, ok);
  },
});

export const availableSlotsAction = defineTenantAction({
  schema: schemas.slotsSchema, permission: 'clinic.appointment.read',
  rateLimit: { limit: 300, windowMs: 60_000 },
  handler: async ({ ctx, input }) => clinic.getAvailableSlots(ctx, input.doctorId, input.date),
});

export const addVisitServiceAction = defineTenantAction({
  schema: schemas.addServiceSchema, permission: 'clinic.appointment.read',
  handler: async ({ ctx, input }) => done(ctx, { id: await clinic.addVisitService(ctx, input) }),
});

export const removeVisitServiceAction = defineTenantAction({
  schema: schemas.removeServiceSchema, permission: 'clinic.appointment.read',
  handler: async ({ ctx, input }) => done(ctx, (await clinic.removeVisitService(ctx, input.lineId), ok)),
});

// ---- visit cashier and commissions -------------------------------------------------
export const invoiceVisitAction = defineTenantAction({
  schema: schemas.visitInvoiceSchema, permission: 'clinic.billing.use',
  handler: async ({ ctx, input }) => done(ctx, { invoiceId: await clinic.invoiceVisit(ctx, input.appointmentId, input.discountCents) }),
});

export const payVisitAction = defineTenantAction({
  schema: schemas.visitPaySchema, permission: 'clinic.billing.use',
  rateLimit: { limit: 60, windowMs: 60_000 },
  handler: async ({ ctx, input }) => done(ctx, await clinic.payVisit(ctx, input)),
});

// A doctor without clinic.commission.read gets their own row only (database rule).
export const commissionSummaryAction = defineTenantAction({
  schema: schemas.commissionSummarySchema, permission: 'clinic.appointment.read',
  handler: async ({ ctx, input }) => clinic.getCommissionSummary(ctx, input),
});

export const payCommissionAction = defineTenantAction({
  schema: schemas.commissionPaySchema, permission: ['clinic.commission.read', 'treasury.create'],
  rateLimit: { limit: 10, windowMs: 10 * 60_000 },
  handler: async ({ ctx, input }) => {
    const paidCents = await clinic.payCommission(ctx, input.doctorId, input.until);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/treasury`);
    return done(ctx, { paidCents });
  },
});

export const searchPatientsAction = defineTenantAction({
  schema: schemas.patientSearchSchema, permission: 'clinic.patient.read',
  rateLimit: { limit: 300, windowMs: 60_000 },
  handler: async ({ ctx, input }) => clinic.searchPatients(ctx, input.query),
});
