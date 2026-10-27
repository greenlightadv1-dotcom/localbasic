import { describe, expect, it } from 'vitest';
import { bookSchema, emrSchema, statusSchema } from './schemas';
import { returnSchema, transferDecideSchema } from '@/modules/retail/operations/schemas';

const id = '7d0c8c8e-7a54-4a4f-9a51-6c2f6e1f0a11';

describe('clinic schemas', () => {
  it('accepts vitals in range and rejects impossible ones', () => {
    expect(emrSchema.safeParse({ type: 'vitals', patientId: id, vitals: { pulseBpm: 78, systolicMmhg: 120, diastolicMmhg: 80 } }).success).toBe(true);
    expect(emrSchema.safeParse({ type: 'vitals', patientId: id, vitals: { pulseBpm: 900 } }).success).toBe(false);
    expect(emrSchema.safeParse({ type: 'vitals', patientId: id, vitals: {} }).success).toBe(false);
    expect(emrSchema.safeParse({ type: 'vitals', patientId: id, vitals: { systolicMmhg: 80, diastolicMmhg: 90 } }).success).toBe(false);
  });

  it('upper-cases and validates ICD-10 codes', () => {
    const r = emrSchema.safeParse({ type: 'diagnosis', patientId: id, diagnosisCode: 'l70.0' });
    expect(r.success && r.data.type === 'diagnosis' && r.data.diagnosisCode).toBe('L70.0');
    expect(emrSchema.safeParse({ type: 'diagnosis', patientId: id, diagnosisCode: 'acne' }).success).toBe(false);
  });

  it('needs a reason to cancel', () => {
    expect(statusSchema.safeParse({ appointmentId: id, status: 'cancelled' }).success).toBe(false);
    expect(statusSchema.safeParse({ appointmentId: id, status: 'cancelled', reason: 'اعتذر' }).success).toBe(true);
  });

  it('requires an offset on booking times', () => {
    expect(bookSchema.safeParse({ patientId: id, doctorId: id, startsAt: '2026-11-01T10:00:00' }).success).toBe(false);
    expect(bookSchema.safeParse({ patientId: id, doctorId: id, startsAt: '2026-11-01T10:00:00+02:00' }).success).toBe(true);
  });
});

describe('retail operation schemas', () => {
  it('an exchange needs new items', () => {
    const base = { invoiceId: id, items: [{ variantId: id, quantity: 1 }], resolution: 'exchange' as const };
    expect(returnSchema.safeParse(base).success).toBe(false);
    expect(returnSchema.safeParse({ ...base, exchangeItems: [{ variantId: id, quantity: 1 }] }).success).toBe(true);
  });

  it('a rejection needs a note', () => {
    expect(transferDecideSchema.safeParse({ transferId: id, approve: false }).success).toBe(false);
    expect(transferDecideSchema.safeParse({ transferId: id, approve: true }).success).toBe(true);
  });
});
