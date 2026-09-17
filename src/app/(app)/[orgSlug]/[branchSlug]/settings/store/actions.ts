'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { defineTenantAction } from '@/lib/action';
import { saveStoreSettings } from '@/modules/retail/store/settings';

/** Money arrives as a typed string and becomes minor units exactly once. */
const cents = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    const text = String(v).trim().replace(/[,\s]/g, '');
    if (text === '') return 0;
    if (!/^\d+(\.\d{0,2})?$/.test(text)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'مبلغ غير صالح' });
      return z.NEVER;
    }
    const [whole = '0', fraction = ''] = text.split('.');
    return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  })
  .pipe(z.number().int().nonnegative());

export const saveStoreSettingsAction = defineTenantAction({
  schema: z.object({
    enabled: z.coerce.boolean(),
    pickup: z.coerce.boolean(),
    delivery: z.coerce.boolean(),
    deliveryFeeCents: cents,
    minOrderCents: cents,
  }),
  permission: 'settings.manage',
  handler: async ({ ctx, input }) => {
    await saveStoreSettings(ctx, input);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/settings/store`);
    return { ok: true };
  },
});
