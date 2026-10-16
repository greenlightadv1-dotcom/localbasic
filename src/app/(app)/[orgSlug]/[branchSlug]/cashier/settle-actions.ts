'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { defineTenantAction } from '@/lib/action';
import * as crm from '@/modules/restaurant/crm/service';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

/** Cashier settle-dialog hooks: promotions, and charging a house account. */
function refresh(ctx: { organizationSlug: string; branchSlug: string }) {
  for (const p of ['/cashier', '/accounts', '/orders']) revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}${p}`);
}

export const applyPromotionsAction = defineTenantAction({
  schema: crm.applyPromotionsSchema, permission: 'restaurant.pos.use',
  handler: async ({ ctx, input }) => { const r = await crm.applyPromotions(ctx, input); refresh(ctx); return r; },
});

export const chargeAccountAction = defineTenantAction({
  schema: crm.chargeSchema, permission: 'restaurant.account.charge',
  handler: async ({ ctx, input }) => {
    const r = await crm.chargeOrder(ctx, input);
    refresh(ctx);
    return { amountCents: Number(r.amount_cents), balanceCents: Number(r.balance_cents) };
  },
});

/**
 * Active house accounts the cashier can charge to, with each balance so the
 * till can name the over-limit amount a manager is asked to approve. The
 * ledger itself is readable only with restaurant.account.manage, so the
 * balances are summed server-side (organization-scoped) after this action's
 * own restaurant.account.charge check.
 */
export const listChargeAccountsAction = defineTenantAction({
  schema: z.object({}), permission: 'restaurant.account.charge',
  handler: async ({ ctx }) => {
    const supabase = createSupabaseServerClient();
    const { data } = await supabase.from('restaurant_house_accounts')
      .select('customer_id, credit_limit_cents').eq('organization_id', ctx.organizationId).eq('is_active', true);
    const ids = (data ?? []).map((a) => a.customer_id);
    if (!ids.length) return [];
    const admin = createSupabaseAdminClient();
    const [{ data: customers }, { data: entries }] = await Promise.all([
      admin.from('customers').select('id, name').eq('organization_id', ctx.organizationId).in('id', ids),
      admin.from('restaurant_account_entries').select('customer_id, amount_cents').eq('organization_id', ctx.organizationId).in('customer_id', ids),
    ]);
    return (data ?? []).map((a) => ({
      customerId: a.customer_id,
      name: customers?.find((c) => c.id === a.customer_id)?.name ?? '—',
      limitCents: Number(a.credit_limit_cents),
      balanceCents: (entries ?? []).filter((e) => e.customer_id === a.customer_id).reduce((s, e) => s + Number(e.amount_cents), 0),
    }));
  },
});
