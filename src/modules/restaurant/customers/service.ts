import 'server-only';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { toAppError } from '@/lib/errors';
import { requirePermission, type TenantContext } from '@/modules/core/tenancy/context';

export type DirectoryRow = {
  phone: string;
  name: string;
  orders: number;
  spentCents: number;
  points: number;
  loyaltyEnabled: boolean;
  lastOrderAt: string | null;
  /** Verified device bindings for this number. */
  devices: number;
  /** The staff-created customer record, when there is one. */
  customerId: string | null;
};

/** One row per person, grouped by phone number across every spelling of it. */
export async function listCustomerDirectory(ctx: TenantContext): Promise<{ rows: DirectoryRow[]; truncated: boolean }> {
  requirePermission(ctx, 'customer.read');
  const LIMIT = 1000;
  const supabase = createSupabaseServerClient();
  // One extra row tells us whether the list was cut off.
  const { data, error } = await supabase.rpc('restaurant_customer_directory', {
    p_org: ctx.organizationId,
    p_limit: LIMIT + 1,
  });
  if (error) throw toAppError(error, 'listCustomerDirectory');

  const raw = (data ?? []) as unknown as {
    out_phone: string; out_name: string; out_orders: number; out_spent_cents: number;
    out_points: number; out_loyalty_enabled: boolean; out_last_order_at: string | null;
    out_devices: number; out_customer_id: string | null;
  }[];
  const rows = raw.slice(0, LIMIT).map((r) => ({
    phone: r.out_phone,
    name: r.out_name,
    orders: Number(r.out_orders),
    spentCents: Number(r.out_spent_cents),
    points: Number(r.out_points),
    loyaltyEnabled: r.out_loyalty_enabled,
    lastOrderAt: r.out_last_order_at,
    devices: Number(r.out_devices),
    customerId: r.out_customer_id,
  }));
  return { rows, truncated: raw.length > LIMIT };
}

export const resetCustomerSchema = z.object({
  phone: z.string().trim().min(6).max(32),
  removeCustomer: z.boolean().default(true),
});
export type ResetCustomerInput = z.infer<typeof resetCustomerSchema>;

/**
 * Removes every verified device bound to this phone, so the guest must verify
 * over WhatsApp again, and (optionally) soft-deletes their staff-created
 * record. Order history is kept.
 */
export async function resetCustomer(
  ctx: TenantContext,
  input: ResetCustomerInput,
): Promise<{ devicesRemoved: number; customersRemoved: number }> {
  requirePermission(ctx, 'customer.update');
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .rpc('restaurant_customer_reset', {
      p_org: ctx.organizationId,
      p_phone: input.phone,
      p_remove_customer: input.removeCustomer,
    })
    .single();
  if (error?.code === '42501') throw toAppError(error, 'resetCustomer forbidden');
  if (error) throw toAppError(error, 'resetCustomer');
  const row = data as unknown as { out_devices_removed: number; out_customers_removed: number };
  return { devicesRemoved: Number(row.out_devices_removed), customersRemoved: Number(row.out_customers_removed) };
}
