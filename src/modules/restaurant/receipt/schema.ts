import { z } from 'zod';

/**
 * Validation for the receipt details form, shared by the form (instant
 * feedback) and the server action (the real check). The database repeats the
 * same rules in 0101 — both in the save function and as column constraints —
 * so no path can store text these rules refuse.
 *
 * Refused everywhere: control characters (newlines only in the two notes) and
 * Unicode bidi-override characters, which can make a printed receipt read
 * differently from what was typed. HTML is never stripped here because it is
 * never trusted: the receipt template escapes every value.
 */
const CONTROL = /[\u0000-\u001F\u007F]/;
const BIDI = /[\u202A-\u202E\u2066-\u2069]/;
const UNSAFE = 'يحتوي على رموز غير مسموحة';

function line(max: number) {
  return z
    .string()
    .trim()
    .max(max, `الحد الأقصى ${max} حرفًا`)
    .refine((v) => !CONTROL.test(v) && !BIDI.test(v), UNSAFE);
}

function note() {
  return z
    .string()
    .transform((v) => v.replace(/\r/g, '').trim())
    .refine((v) => v.length <= 300, 'الحد الأقصى 300 حرف')
    .refine((v) => v.split('\n').length <= 4, 'الحد الأقصى 4 أسطر')
    .refine((v) => !CONTROL.test(v.replace(/\n/g, '')) && !BIDI.test(v), UNSAFE);
}

/** Digits (Latin or Arabic-Indic), Latin letters, spaces, dashes and slashes. */
const code = z
  .string()
  .trim()
  .regex(/^[0-9٠-٩A-Za-z /-]{0,32}$/, 'أرقام وحروف لاتينية وشرطات فقط (حتى 32)');

const phone = z
  .string()
  .trim()
  .regex(/^([0-9٠-٩+() -]{6,32})?$/, 'رقم الهاتف غير صالح');

export const receiptSettingsSchema = z.object({
  legalName: line(120),
  commercialRegistration: code,
  taxId: code,
  headerNote: note(),
  footerNote: note(),
  branchDisplayName: line(120),
  branchAddress: line(200),
  branchPhone: phone,
});
export type ReceiptSettingsInput = z.infer<typeof receiptSettingsSchema>;
