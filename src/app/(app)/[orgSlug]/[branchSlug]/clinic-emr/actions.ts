'use server';

import { revalidatePath } from 'next/cache';
import { defineTenantAction } from '@/lib/action';
import * as schemas from '@/modules/clinic/schemas';
import * as clinic from '@/modules/clinic/service';

/**
 * Medical records and prescriptions (0111/0113). Records are append-only: a
 * correction is an 'amendment' entry pointing at the original. Attachments
 * are uploaded by the browser to the private 'clinic-records' bucket at
 * clinic.attachmentPath() first; this action then records them.
 */
type Scope = { organizationSlug: string; branchSlug: string };
const path = (ctx: Scope) => `/${ctx.organizationSlug}/${ctx.branchSlug}/clinic-emr`;
const done = <T>(ctx: Scope, value: T) => { revalidatePath(path(ctx)); return value; };

export const addEmrRecordAction = defineTenantAction({
  schema: schemas.emrSchema, permission: 'clinic.emr.write',
  rateLimit: { limit: 120, windowMs: 60_000 },
  handler: async ({ ctx, input }) => done(ctx, { id: await clinic.addEmrRecord(ctx, input) }),
});

export const issuePrescriptionAction = defineTenantAction({
  schema: schemas.prescriptionIssueSchema, permission: 'clinic.prescription.write',
  rateLimit: { limit: 60, windowMs: 60_000 },
  handler: async ({ ctx, input }) => done(ctx, await clinic.issuePrescription(ctx, input)),
});

export const cancelPrescriptionAction = defineTenantAction({
  schema: schemas.prescriptionCancelSchema, permission: 'clinic.prescription.write',
  handler: async ({ ctx, input }) => done(ctx, (await clinic.cancelPrescription(ctx, input.prescriptionId, input.reason), { ok: true as const })),
});

/** Rotates the token (the previous link stops working) and returns the link plus a wa.me URL. */
export const sharePrescriptionAction = defineTenantAction({
  schema: schemas.prescriptionShareSchema, permission: 'clinic.prescription.write',
  rateLimit: { limit: 30, windowMs: 60_000 },
  handler: async ({ ctx, input }) => clinic.sharePrescription(ctx, input.prescriptionId),
});
