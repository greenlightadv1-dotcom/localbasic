import { describe, expect, it } from 'vitest';
import { receiptSettingsSchema } from './schema';

const OK = {
  legalName: 'شركة ألفا', commercialRegistration: '12345', taxId: '123-456-789',
  headerNote: 'سطر 1\r\nسطر 2', footerNote: '', branchDisplayName: '', branchAddress: 'المعادي', branchPhone: '+20 2 2555 0000',
};

describe('receiptSettingsSchema', () => {
  it('accepts normal details, trims, and drops carriage returns', () => {
    const r = receiptSettingsSchema.parse({ ...OK, legalName: '  شركة ألفا  ' });
    expect(r.legalName).toBe('شركة ألفا');
    expect(r.headerNote).toBe('سطر 1\nسطر 2');
  });

  it('accepts Arabic-Indic digits and empty optional fields', () => {
    expect(receiptSettingsSchema.safeParse({ ...OK, taxId: '١٢٣-٤٥٦-٧٨٩', branchPhone: '' }).success).toBe(true);
  });

  it.each([
    ['legalName', 'x'.repeat(121)],
    ['legalName', 'a\nb'],
    ['legalName', 'abc\u202Edcba'],
    ['branchAddress', 'tab\there'],
    ['commercialRegistration', '<script>'],
    ['taxId', '123;drop table'],
    ['branchPhone', '0100 <b>'],
    ['branchPhone', '123'],
    ['headerNote', '1\n2\n3\n4\n5'],
    ['footerNote', 'y'.repeat(301)],
    ['footerNote', 'bell\u0007'],
  ])('refuses unsafe %s', (key, value) => {
    expect(receiptSettingsSchema.safeParse({ ...OK, [key]: value }).success).toBe(false);
  });
});
