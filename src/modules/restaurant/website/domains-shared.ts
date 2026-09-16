/**
 * Domain vocabulary shared between the server service and the client forms.
 *
 * Separate from domains.ts because that module is `server-only`.
 */

export const DOMAIN_STATUSES = ['pending', 'verified', 'active', 'disabled'] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];

export const DOMAIN_STATUS_LABELS: Record<DomainStatus, string> = {
  pending: 'بانتظار التوثيق',
  verified: 'موثّق',
  active: 'مفعّل',
  disabled: 'موقوف',
};

export const DOMAIN_STATUS_HINTS: Record<DomainStatus, string> = {
  pending: 'أضف سجل TXT الموضّح أدناه ثم اضغط «تحقّق».',
  verified: 'تم إثبات ملكيتك للنطاق. فعّله ليبدأ في عرض موقعك.',
  active: 'النطاق مفعّل على LocalBasic. تأكد أيضًا من إعدادات DNS لدى مزوّد النطاق.',
  disabled: 'موقوف — لا يعرض موقعك، والنطاق ما زال محجوزًا باسمك.',
};

export type WebsiteDomain = {
  id: string;
  hostname: string;
  status: DomainStatus;
  isPrimary: boolean;
  verificationMethod: string;
  verificationAttemptedAt: string | null;
  verificationError: string | null;
  verifiedAt: string | null;
  activatedAt: string | null;
  createdAt: string;
};

/** The name the customer creates the TXT record at. */
export function challengeRecordName(hostname: string): string {
  return `_localbasic.${hostname}`;
}

/**
 * The DNS records a customer needs, as instructions.
 *
 * These describe what their DNS provider must publish. LocalBasic does not
 * operate DNS and cannot make these changes for them.
 */
export function dnsInstructions(hostname: string): {
  verification: { type: string; name: string; value: string };
  routing: { type: string; name: string; value: string }[];
} {
  const isApex = hostname.split('.').length === 2;
  return {
    verification: {
      type: 'TXT',
      name: challengeRecordName(hostname),
      value: 'القيمة التي ظهرت لك عند إضافة النطاق',
    },
    routing: isApex
      ? [{ type: 'A', name: hostname, value: '76.76.21.21' }]
      : [{ type: 'CNAME', name: hostname, value: 'cname.vercel-dns.com' }],
  };
}
