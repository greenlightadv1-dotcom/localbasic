import { z } from 'zod';

/**
 * Lead vocabulary and input shapes.
 *
 * Separate from service.ts because the admin forms are client components: the
 * service is `server-only`, so importing these from there would drag server
 * code into the browser bundle.
 */
export const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'won', 'lost'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: 'جديد',
  contacted: 'تم التواصل',
  qualified: 'مؤهل',
  won: 'تم التعاقد',
  lost: 'خسارة',
};

export const LEAD_SOURCES = ['website', 'whatsapp', 'referral', 'call', 'walk_in', 'other'] as const;
export const LEAD_SOURCE_LABELS: Record<string, string> = {
  website: 'الموقع',
  whatsapp: 'واتساب',
  referral: 'ترشيح',
  call: 'مكالمة',
  walk_in: 'زيارة',
  other: 'أخرى',
};

export const createLeadInput = z.object({
  name: z.string().trim().min(2, 'الاسم مطلوب').max(120),
  phone: z.string().trim().min(6, 'رقم غير صحيح').max(32),
  businessName: z.string().trim().max(160).optional().or(z.literal('')),
  requestedService: z.string().trim().max(32).optional().or(z.literal('')),
  source: z.enum(LEAD_SOURCES).default('whatsapp'),
  notes: z.string().trim().max(4000).optional().or(z.literal('')),
});

export const updateLeadInput = z.object({
  id: z.string().uuid(),
  status: z.enum(LEAD_STATUSES),
  notes: z.string().trim().max(4000).optional().or(z.literal('')),
});

