import { describe, expect, it } from 'vitest';
import { buildBillHtml, buildNoSaleHtml } from './bill-html';

const bill = {
  businessName: 'مطعم <x>', orderNumber: '12', tableName: 'T1', currency: 'EGP',
  lines: [{ quantity: 2, name: 'كفتة', note: 'بدون <b>بصل</b>' }], totalCents: 20000, paidCents: 0, copy: 1, printedAt: new Date('2026-10-16T10:00:00Z'),
};

describe('pre-bill and no-sale slips', () => {
  it('marks a reprinted bill as a copy', () => {
    expect(buildBillHtml(bill)).not.toContain('نسخة رقم');
    expect(buildBillHtml({ ...bill, copy: 3 })).toContain('نسخة رقم 3');
  });
  it('says it is not a receipt and escapes text', () => {
    const html = buildBillHtml(bill);
    expect(html).toContain('ليست إيصال دفع');
    expect(html).not.toContain('<b>بصل</b>');
    expect(html).toContain('مطعم &lt;x&gt;');
  });
  it('no-sale slip carries the reason', () => {
    expect(buildNoSaleHtml({ businessName: 'م', cashier: 'سارة', reason: 'فكة <script>', at: new Date() })).toContain('فكة &lt;script&gt;');
  });
});
