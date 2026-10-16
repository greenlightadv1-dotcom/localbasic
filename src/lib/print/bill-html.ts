import { formatMoney } from '@/lib/money';
import { escapeHtml as e } from './receipt-html';

/**
 * Small 80mm slips the till prints that are not receipts: the pre-bill a
 * table asks for before paying, and the "no sale" slip printed when the
 * drawer is opened without a sale (a receipt printer set to kick the drawer
 * on print opens it). A pre-bill from its second print on says which copy it
 * is (0108), so a reprinted bill is visibly a copy.
 */
export type BillData = {
  businessName: string; orderNumber: string; tableName: string | null; currency: string;
  lines: { quantity: number; name: string; note?: string | null }[];
  totalCents: number; paidCents: number; copy: number; printedAt: Date;
};

const STYLE = `<style>
  @page { size: 80mm auto; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 4mm; width: 80mm; font: 13px/1.45 system-ui, sans-serif; color: #000; background: #fff; }
  h1 { font-size: 16px; text-align: center; margin: 0 0 2mm; }
  .c { text-align: center; } .m { font-size: 11px; } .b { font-weight: 700; }
  .row { display: flex; justify-content: space-between; gap: 2mm; }
  hr { border: 0; border-top: 1px dashed #000; margin: 2mm 0; }
  .copy { border: 1px solid #000; text-align: center; font-weight: 700; padding: 1mm; margin: 2mm 0; }
</style>`;

const stamp = (d: Date) => e(d.toLocaleString('ar-EG', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }));

export function buildBillHtml(b: BillData): string {
  const money = (c: number) => e(formatMoney(c, b.currency));
  const items = b.lines.map((l) =>
    `<div class="row"><span>${e(String(l.quantity))}× ${e(l.name)}</span></div>${l.note ? `<div class="m">— ${e(l.note)}</div>` : ''}`).join('');
  const due = Math.max(b.totalCents - b.paidCents, 0);
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${e(`فاتورة مبدئية ${b.orderNumber}`)}</title>${STYLE}</head><body>
<h1>${e(b.businessName)}</h1>
<p class="c b">فاتورة مبدئية — ليست إيصال دفع</p>
${b.copy > 1 ? `<div class="copy">نسخة رقم ${e(String(b.copy))}</div>` : ''}
<div class="row m"><span>طلب #${e(b.orderNumber)}</span><span>${b.tableName ? `طاولة ${e(b.tableName)}` : ''}</span></div>
<div class="m">${stamp(b.printedAt)}</div>
<hr>${items}<hr>
<div class="row b"><span>الإجمالي</span><span>${money(b.totalCents)}</span></div>
${b.paidCents > 0 ? `<div class="row"><span>مدفوع</span><span>${money(b.paidCents)}</span></div><div class="row b"><span>المتبقي</span><span>${money(due)}</span></div>` : ''}
</body></html>`;
}

export function buildNoSaleHtml(s: { businessName: string; cashier: string; reason: string; at: Date }): string {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>فتح الدرج</title>${STYLE}</head><body>
<h1>${e(s.businessName)}</h1>
<p class="c b">فتح الدرج — بدون بيع</p>
<hr><div>الموظف: ${e(s.cashier)}</div><div>السبب: ${e(s.reason)}</div><div class="m">${stamp(s.at)}</div>
</body></html>`;
}
