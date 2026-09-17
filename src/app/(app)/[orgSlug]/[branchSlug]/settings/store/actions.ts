'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { defineTenantAction } from '@/lib/action';
import { saveStoreSettings } from '@/modules/retail/store/settings';
import { createProvider } from '@/modules/retail/shipping/service';

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

/**
 * Add a carrier.
 *
 * `providerKey` is fixed to 'manual' here: it is the only adapter this
 * deployment implements, and offering a key the application cannot honour
 * would mean a shop configuring a courier that silently never books. A real
 * integration adds an adapter first, then this list grows.
 */
export const createCarrierAction = defineTenantAction({
  schema: z.object({
    name: z.string().trim().min(2, 'اسم شركة الشحن مطلوب').max(120),
    defaultCostCents: cents,
    phone: z.string().trim().max(40).optional().or(z.literal('')),
  }),
  permission: 'settings.manage',
  handler: async ({ ctx, input }) => {
    const id = await createProvider(ctx, {
      name: input.name,
      providerKey: 'manual',
      defaultCostCents: input.defaultCostCents,
      phone: input.phone || undefined,
    });
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/settings/store`);
    return { id };
  },
});
