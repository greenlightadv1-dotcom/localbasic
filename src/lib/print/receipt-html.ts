import { formatMoney } from '@/lib/money';
import { RECEIPT_DISCLAIMER_AR } from '@/modules/core/legal/receipt';

/**
 * The customer receipt (بون الحساب) as one self-contained HTML document, laid
 * out for an 80mm thermal roll.
 *
 * Built as a string and printed from a hidden frame (see print-html.ts) rather
 * than by printing the page the cashier is looking at: the till's own screen —
 * sidebar, order list, open dialogs — never reaches the printer, and the same
 * output comes out whichever screen the button was pressed on.
 *
 * Every dynamic value is escaped. Product names and the customer's text are
 * user-controlled, and this string is written into a document.
 */

export type ReceiptData = {
  businessName: string;
  branchName: string;
  phone: string | null;
  /** The receipt's own number. */
  number: string;
  /** The order it settles, and where it was served — both optional. */
  orderNumber: string | null;
  tableName: string | null;
  /** ISO timestamp the receipt is dated (the last payment, else issue time). */
  issuedAt: string;
  currency: string;
  items: { description: string; quantity: number; totalCents: number }[];
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  payments: { method: string; amountCents: number; kind: 'payment' | 'refund' }[];
  paidCents: number;
  /** Hide the "powered by" line (white-label plans). */
  whiteLabel: boolean;
};

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: 'نقدي',
  card: 'بطاقة',
  transfer: 'تحويل',
  wallet: 'محفظة',
  online: 'أونلاين',
  other: 'أخرى',
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const e = escapeHtml;

export function buildReceiptHtml(r: ReceiptData): string {
  const money = (cents: number) => e(formatMoney(cents, r.currency));
  const when = e(
    new Date(r.issuedAt).toLocaleString('ar-EG', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }),
  );
  const due = r.totalCents - r.paidCents;

  const items = r.items
    .map(
      (i) => `<tr><td class="name"><span class="q">${e(String(i.quantity))}×</span> ${e(i.description)}</td>` +
        `<td class="amt">${money(i.totalCents)}</td></tr>`,
    )
    .join('');

  const payments = r.payments
    .map(
      (p) => `<div class="row"><span>${p.kind === 'refund' ? 'مرتجع' : 'مدفوع'} · ` +
        `${e(PAYMENT_METHOD_LABELS[p.method] ?? p.method)}</span><span>${money(Math.abs(p.amountCents))}</span></div>`,
    )
    .join('');

  return `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<title>${e(`إيصال ${r.number}`)}</title>
<style>
  @page { size: 80mm auto; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { width: 72mm; margin: 0 auto; padding: 4mm 2mm; color: #000;
         font: 12px/1.45 "Segoe UI", Tahoma, Arial, sans-serif; }
  .c { text-align: center; }
  h1 { font-size: 16px; margin: 0; }
  .muted { opacity: .75; font-size: 11px; }
  .sep { border-top: 1px dashed #000; margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 2px 0; vertical-align: top; }
  td.amt { text-align: end; white-space: nowrap; padding-inline-start: 6px; }
  .q { font-weight: 700; }
  .row { display: flex; justify-content: space-between; gap: 6px; }
  .total { font-size: 15px; font-weight: 700; border-top: 1px solid #000; margin-top: 4px; padding-top: 4px; }
  .fine { font-size: 9px; line-height: 1.5; opacity: .75; }
  @media screen { body { border: 1px solid #ccc; margin-top: 8px; } }
</style></head>
<body>
  <div class="c">
    <h1>${e(r.businessName)}</h1>
    <div>${e(r.branchName)}</div>
    ${r.phone ? `<div class="muted" dir="ltr">${e(r.phone)}</div>` : ''}
    <div style="margin-top:6px;font-weight:700">إيصال ${e(r.number)}</div>
    ${r.orderNumber ? `<div class="muted">طلب #${e(r.orderNumber)}${r.tableName ? ` · طاولة ${e(r.tableName)}` : ''}</div>` : ''}
    <div class="muted">${when}</div>
  </div>
  <div class="sep"></div>
  <table>${items}</table>
  <div class="sep"></div>
  <div class="row"><span>المجموع</span><span>${money(r.subtotalCents)}</span></div>
  ${r.discountCents > 0 ? `<div class="row"><span>الخصم</span><span>− ${money(r.discountCents)}</span></div>` : ''}
  ${r.taxCents > 0 ? `<div class="row"><span>الضريبة</span><span>${money(r.taxCents)}</span></div>` : ''}
  <div class="row total"><span>الإجمالي</span><span>${money(r.totalCents)}</span></div>
  ${payments ? `<div class="sep"></div>${payments}` : ''}
  ${due > 0 ? `<div class="row total"><span>المتبقي</span><span>${money(due)}</span></div>` : ''}
  <div class="sep"></div>
  <p class="fine">${e(RECEIPT_DISCLAIMER_AR)}</p>
  <div class="c muted" style="margin-top:6px">شكرًا لزيارتكم</div>
  ${r.whiteLabel ? '' : '<div class="c fine">مدعوم بواسطة LocalBasic</div>'}
</body></html>`;
}
