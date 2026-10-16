import 'server-only';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { staffDbError, toDataUnavailable } from '@/lib/errors';
import { hashToken } from '@/lib/tokens';
import type { TenantContext } from '@/modules/core/tenancy/context';

/**
 * Order intake integrations (0106). A key is generated here, shown to the
 * manager ONCE, and only its SHA-256 is stored. The public route hashes the
 * presented key and hands it to the database, which finds the integration
 * (and so the organization and branch) by that hash alone.
 */

export type Integration = { id: string; name: string; source: string; keyPrefix: string; autoConfirm: boolean; isActive: boolean; lastUsedAt: string | null; createdAt: string };

export const integrationSchema = z.object({
  name: z.string().trim().min(1, 'اسم التكامل مطلوب').max(80),
  source: z.string().trim().regex(/^[a-z0-9_]{2,40}$/, 'المصدر: حروف إنجليزية صغيرة وأرقام فقط (مثال: talabat)'),
  autoConfirm: z.boolean().default(true),
});
export const integrationSetSchema = z.object({ id: z.string().uuid(), isActive: z.boolean().optional(), autoConfirm: z.boolean().optional() });

export async function listIntegrations(ctx: TenantContext): Promise<Integration[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.from('restaurant_integrations')
    .select('id, name, source, key_prefix, auto_confirm, is_active, last_used_at, created_at').eq('branch_id', ctx.branchId).order('created_at');
  if (error) throw toDataUnavailable(error, 'listIntegrations');
  return (data ?? []).map((i) => ({ id: i.id, name: i.name, source: i.source, keyPrefix: i.key_prefix, autoConfirm: i.auto_confirm, isActive: i.is_active, lastUsedAt: i.last_used_at, createdAt: i.created_at }));
}

export async function createIntegration(ctx: TenantContext, i: z.infer<typeof integrationSchema>): Promise<{ id: string; key: string }> {
  const key = `lbk_${randomBytes(24).toString('base64url')}`;
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('restaurant_integration_create' as never, {
    p_org: ctx.organizationId, p_branch: ctx.branchId, p_name: i.name, p_source: i.source,
    p_key_hash: hashToken(key), p_key_prefix: key.slice(0, 8), p_auto_confirm: i.autoConfirm,
  } as never);
  if (error) throw staffDbError(error, 'createIntegration');
  return { id: data as unknown as string, key };
}

export async function setIntegration(ctx: TenantContext, i: z.infer<typeof integrationSetSchema>) {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('restaurant_integration_set' as never, {
    p_org: ctx.organizationId, p_id: i.id, p_active: i.isActive ?? null, p_auto_confirm: i.autoConfirm ?? null,
  } as never);
  if (error) throw staffDbError(error, 'setIntegration');
}

// ---------------------------------------------------------------------------
// The public intake (service role; called only from /api/integrations/*)
// ---------------------------------------------------------------------------
export const intakeOrderSchema = z.object({
  external_id: z.string().trim().min(1).max(120),
  type: z.enum(['delivery', 'pickup']).default('delivery'),
  customer: z.object({ name: z.string().trim().min(1).max(120), phone: z.string().trim().min(7).max(30) }),
  delivery: z.object({
    address: z.string().trim().min(4).max(500), area: z.string().trim().max(120).optional(), city: z.string().trim().max(120).optional(),
    landmark: z.string().trim().max(240).optional(), notes: z.string().trim().max(500).optional(),
    latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional(),
  }).optional(),
  items: z.array(z.object({
    variant_id: z.string().uuid(), quantity: z.number().positive().max(999),
    modifier_ids: z.array(z.string().uuid()).max(30).optional(), note: z.string().trim().max(200).optional(),
  })).min(1).max(100),
  note: z.string().trim().max(500).optional(),
  paid: z.boolean().optional(),
  total_cents: z.number().int().min(0).optional(),
}).refine((v) => v.type === 'pickup' || Boolean(v.delivery), { message: 'delivery is required for delivery orders', path: ['delivery'] });

export type IntakeResult = { order_id: string; number: string; status: string; total_cents?: number; duplicate: boolean };

const INTAKE_ERRORS: Record<string, number> = { '28000': 401, '22023': 422, check_violation: 422, '23514': 422, LB429: 429 };

export async function intakeOrder(rawKey: string, payload: z.infer<typeof intakeOrderSchema>): Promise<{ status: number; body: unknown }> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc('restaurant_intake_order' as never, { p_key_hash: hashToken(rawKey), p_payload: payload } as never);
  if (error) {
    const status = INTAKE_ERRORS[error.code ?? ''] ?? (error.code?.startsWith('23') || error.code?.startsWith('22') ? 422 : 500);
    return { status, body: { error: status === 401 ? 'invalid key' : status === 500 ? 'internal error' : error.message } };
  }
  return { status: 200, body: data as IntakeResult };
}

export async function intakeMenu(rawKey: string): Promise<{ status: number; body: unknown }> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc('restaurant_intake_menu' as never, { p_key_hash: hashToken(rawKey) } as never);
  if (error) return { status: error.code === '28000' ? 401 : 500, body: { error: error.code === '28000' ? 'invalid key' : 'internal error' } };
  return { status: 200, body: { items: data } };
}
