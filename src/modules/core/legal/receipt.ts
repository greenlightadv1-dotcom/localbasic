/**
 * Customer-facing financial wording, in one place.
 *
 * LOCAL BASIC ISSUES RECEIPTS (إيصال). It does not issue, and must never
 * appear to issue, an Egyptian tax invoice (فاتورة ضريبية) — integration with
 * the e-invoice system is a future adapter, deliberately not built into Core.
 * The platform makes no claim of tax or legal compliance; the business owner
 * remains independently responsible for their obligations.
 *
 * This lives in Core, not in a vertical, because every vertical that shows a
 * customer a financial document has to show the same words. It is a plain
 * module with no imports so a client component can render it.
 *
 * THIS TEXT IS PENDING LEGAL REVIEW and must not be changed without explicit
 * instruction. Keep it here — one string, one place to review and to translate
 * — rather than inlined in a template.
 */

/** The term for a customer-facing financial document. Never "فاتورة ضريبية". */
export const RECEIPT_TERM_AR = 'إيصال';
export const RECEIPT_TERM_EN = 'Receipt';

export const RECEIPT_DISCLAIMER_AR =
  'هذا إيصال داخلي وليس فاتورة ضريبية معتمدة من منظومة الفاتورة الإلكترونية المصرية. ' +
  'التكامل مع المنظومة الضريبية مؤجل لمرحلة لاحقة، وصاحب النشاط (العميل) مسؤول بشكل ' +
  'مستقل عن التزاماته الضريبية تجاه مصلحة الضرائب المصرية.';
