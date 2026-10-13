import { describe, expect, it } from 'vitest';
import { buildReceiptHtml, escapeHtml, type ReceiptData } from './receipt-html';

/** formatMoney prints Arabic-Indic digits; compare on Latin ones. */
const latin = (s: string) => s.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));

const BASE: ReceiptData = {
  businessName: 'مطعم الحارة',
  branchName: 'الفرع الرئيسي',
  phone: '01000000000',
  number: 'RC-000123',
  orderNumber: '000018',
  tableName: '5',
  issuedAt: '2026-10-13T14:11:36Z',
  currency: 'EGP',
  items: [
    { description: 'شاورما دجاج', quantity: 2, totalCents: 15000 },
    { description: 'عصير برتقال', quantity: 1, totalCents: 4000 },
  ],
  subtotalCents: 19000,
  discountCents: 1000,
  taxCents: 0,
  totalCents: 18000,
  payments: [{ method: 'cash', amountCents: 20000, kind: 'payment' }],
  paidCents: 18000,
  whiteLabel: false,
};

describe('buildReceiptHtml', () => {
  const html = buildReceiptHtml(BASE);

  it('carries the business and branch name, receipt and order numbers', () => {
    expect(html).toContain('مطعم الحارة');
    expect(html).toContain('الفرع الرئيسي');
    expect(html).toContain('RC-000123');
    expect(html).toContain('طلب #000018');
    expect(html).toContain('طاولة 5');
  });

  it('lists every item with its quantity and line total', () => {
    expect(html).toContain('شاورما دجاج');
    expect(html).toContain('عصير برتقال');
    expect(html).toContain('2×');
    expect(html).toContain('1×');
    expect(latin(html)).toMatch(/150/);
    expect(latin(html)).toMatch(/40/);
  });

  it('shows totals, the discount and the payment method', () => {
    expect(html).toContain('الإجمالي');
    expect(html).toContain('الخصم');
    expect(html).toContain('نقدي');
    expect(html).toContain('مدفوع');
  });

  it('includes a dated timestamp, the required disclaimer, and sizes itself for 80mm', () => {
    expect(latin(html)).toContain('2026');
    expect(html).toContain('ليس فاتورة ضريبية');
    expect(html).toContain('@page { size: 80mm auto; margin: 0; }');
  });

  it('reports a balance still due, and omits the line when settled', () => {
    expect(html).not.toContain('المتبقي');
    expect(buildReceiptHtml({ ...BASE, paidCents: 10000 })).toContain('المتبقي');
  });

  it('labels refunds and unknown methods', () => {
    const h = buildReceiptHtml({
      ...BASE,
      payments: [{ method: 'cash', amountCents: -500, kind: 'refund' }, { method: 'crypto', amountCents: 500, kind: 'payment' }],
    });
    expect(h).toContain('مرتجع');
    expect(h).toContain('crypto');
  });

  it('hides the powered-by line on white-label plans', () => {
    expect(html).toContain('LocalBasic');
    expect(buildReceiptHtml({ ...BASE, whiteLabel: true })).not.toContain('LocalBasic');
  });

  it('escapes anything a user can type before writing it into the document', () => {
    const evil = buildReceiptHtml({
      ...BASE,
      businessName: '<script>alert(1)</script>',
      items: [{ description: '"><img src=x onerror=alert(1)>', quantity: 1, totalCents: 100 }],
      tableName: "5'<b>",
    });
    expect(evil).not.toContain('<script>alert');
    expect(evil).not.toContain('<img src=x');
    expect(evil).toContain('&lt;script&gt;');
    expect(evil).toContain('&quot;&gt;&lt;img');
  });
});

describe('escapeHtml', () => {
  it('escapes the five characters that matter', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });
});
