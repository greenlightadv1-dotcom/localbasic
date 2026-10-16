import 'server-only';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { staffDbError, toDataUnavailable } from '@/lib/errors';
import type { TenantContext } from '@/modules/core/tenancy/context';

/** Loyalty rewards, promotions and house accounts (0107). */

async function call(fn: string, args: Record<string, unknown>, context: string): Promise<unknown> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc(fn as never, args as never);
  if (error) throw staffDbError(error, context);
  return data;
}

// ---------------------------------------------------------------------------
// Promotions
// ---------------------------------------------------------------------------
export type PromotionKind = 'happy_hour' | 'bogo' | 'code';
export type Promotion = {
  id: string; name: string; kind: PromotionKind; isActive: boolean; branchId: string | null;
  startsAt: string | null; endsAt: string | null; daysOfWeek: number[]; startTime: string | null; endTime: string | null;
  percentBp: number | null; amountCents: number | null; productIds: string[]; categoryIds: string[];
  buyQty: number | null; getQty: number | null; getPercentBp: number | null; code: string | null;
  minOrderCents: number; maxUses: number | null; uses: number;
};

export async function listPromotions(ctx: TenantContext): Promise<Promotion[]> {
  const supabase = createSupabaseServerClient();
  const [{ data, error }, { data: uses }] = await Promise.all([
    supabase.from('restaurant_promotions').select('*').eq('organization_id', ctx.organizationId).order('created_at', { ascending: false }),
    supabase.from('restaurant_order_promotions').select('promotion_id').eq('organization_id', ctx.organizationId).limit(5000),
  ]);
  if (error) throw toDataUnavailable(error, 'listPromotions');
  return (data ?? []).map((p) => ({
    id: p.id, name: p.name, kind: p.kind as PromotionKind, isActive: p.is_active, branchId: p.branch_id,
    startsAt: p.starts_at, endsAt: p.ends_at, daysOfWeek: p.days_of_week ?? [], startTime: p.start_time, endTime: p.end_time,
    percentBp: p.percent_bp, amountCents: p.amount_cents, productIds: p.product_ids ?? [], categoryIds: p.category_ids ?? [],
    buyQty: p.buy_qty, getQty: p.get_qty, getPercentBp: p.get_percent_bp, code: p.code, minOrderCents: p.min_order_cents,
    maxUses: p.max_uses, uses: (uses ?? []).filter((u) => u.promotion_id === p.id).length,
  }));
}

export const promotionSchema = z.object({
  id: z.string().uuid().nullable(),
  name: z.string().trim().min(1, 'اسم العرض مطلوب').max(120),
  kind: z.enum(['happy_hour', 'bogo', 'code']),
  isActive: z.boolean().default(true),
  allBranches: z.boolean().default(true),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  endTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  percent: z.coerce.number().min(0).max(100).nullable().optional(),
  amountCents: z.coerce.number().int().min(0).max(100_000_000).nullable().optional(),
  productIds: z.array(z.string().uuid()).max(200).default([]),
  categoryIds: z.array(z.string().uuid()).max(100).default([]),
  buyQty: z.coerce.number().int().min(1).max(50).nullable().optional(),
  getQty: z.coerce.number().int().min(1).max(50).nullable().optional(),
  getPercent: z.coerce.number().min(1).max(100).nullable().optional(),
  code: z.string().trim().regex(/^[A-Za-z0-9_-]{3,32}$/, 'الكود: 3–32 حرفًا إنجليزيًا أو رقمًا').nullable().optional().or(z.literal('')),
  minOrderCents: z.coerce.number().int().min(0).max(100_000_000).default(0),
  maxUses: z.coerce.number().int().min(1).max(1_000_000).nullable().optional(),
}).superRefine((v, c) => {
  if (v.kind === 'happy_hour' && (!v.percent || !v.startTime || !v.endTime)) c.addIssue({ code: 'custom', path: ['percent'], message: 'الساعة السعيدة تحتاج نسبة خصم ووقت بداية ونهاية' });
  if (v.kind === 'bogo' && (!v.buyQty || !v.getQty || !v.getPercent)) c.addIssue({ code: 'custom', path: ['buyQty'], message: 'حدد اشترِ كم واحصل على كم ونسبة الخصم' });
  if (v.kind === 'code' && (!v.code || (!v.percent && !v.amountCents))) c.addIssue({ code: 'custom', path: ['code'], message: 'الكود يحتاج اسمًا ونسبة أو مبلغ خصم' });
});

export const savePromotion = (ctx: TenantContext, i: z.infer<typeof promotionSchema>) =>
  call('restaurant_promotion_save', {
    p_org: ctx.organizationId, p_id: i.id,
    p_data: {
      name: i.name, kind: i.kind, is_active: i.isActive, branch_id: i.allBranches ? null : ctx.branchId,
      starts_at: i.startsAt ?? null, ends_at: i.endsAt ?? null, days_of_week: i.daysOfWeek,
      start_time: i.startTime ?? null, end_time: i.endTime ?? null,
      percent_bp: i.percent ? Math.round(i.percent * 100) : null, amount_cents: i.amountCents || null,
      product_ids: i.productIds, category_ids: i.categoryIds,
      buy_qty: i.kind === 'bogo' ? i.buyQty : null, get_qty: i.kind === 'bogo' ? i.getQty : null,
      get_percent_bp: i.kind === 'bogo' && i.getPercent ? Math.round(i.getPercent * 100) : null,
      code: i.kind === 'code' ? i.code || null : null, min_order_cents: i.minOrderCents, max_uses: i.maxUses ?? null,
    },
  }, 'savePromotion') as Promise<string>;

export const applyPromotionsSchema = z.object({ orderId: z.string().uuid(), code: z.string().trim().max(32).optional() });
export type AppliedPromotions = { promotionsCents: number; couponsCents: number; discountCents: number; applied: { name: string; amountCents: number }[] };

export async function applyPromotions(ctx: TenantContext, i: z.infer<typeof applyPromotionsSchema>): Promise<AppliedPromotions> {
  const d = (await call('restaurant_promotions_apply', { p_org: ctx.organizationId, p_order: i.orderId, p_code: i.code || null }, 'applyPromotions')) as Record<string, unknown>;
  return {
    promotionsCents: Number(d.promotions_cents), couponsCents: Number(d.coupons_cents), discountCents: Number(d.discount_cents),
    applied: ((d.applied ?? []) as Record<string, unknown>[]).map((a) => ({ name: String(a.name), amountCents: Number(a.amount_cents) })),
  };
}

// ---------------------------------------------------------------------------
// Loyalty
// ---------------------------------------------------------------------------
export type Reward = { id: string; name: string; pointsCost: number; kind: 'discount' | 'free_item'; valueCents: number | null; variantId: string | null; isActive: boolean };

export async function listRewards(ctx: TenantContext): Promise<Reward[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.from('restaurant_loyalty_rewards')
    .select('id, name, points_cost, kind, value_cents, variant_id, is_active').eq('organization_id', ctx.organizationId).order('points_cost');
  if (error) throw toDataUnavailable(error, 'listRewards');
  return (data ?? []).map((r) => ({ id: r.id, name: r.name, pointsCost: r.points_cost, kind: r.kind as Reward['kind'], valueCents: r.value_cents, variantId: r.variant_id, isActive: r.is_active }));
}

export const rewardSchema = z.object({
  id: z.string().uuid().nullable(), name: z.string().trim().min(1, 'اسم المكافأة مطلوب').max(80),
  pointsCost: z.coerce.number().int().min(1).max(1_000_000), kind: z.enum(['discount', 'free_item']),
  valueCents: z.coerce.number().int().min(1).max(100_000_000).nullable().optional(), variantId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().default(true),
});
export const saveReward = (ctx: TenantContext, i: z.infer<typeof rewardSchema>) =>
  call('restaurant_loyalty_reward_save', { p_org: ctx.organizationId, p_id: i.id, p_name: i.name, p_points: i.pointsCost, p_kind: i.kind, p_value_cents: i.valueCents ?? null, p_variant: i.variantId ?? null, p_active: i.isActive }, 'saveReward');

export const pointsAdjustSchema = z.object({ phone: z.string().trim().min(7).max(30), points: z.coerce.number().int().refine((n) => n !== 0, 'عدد النقاط لا يكون صفرًا'), note: z.string().trim().min(1, 'اكتب السبب').max(300) });
export const adjustPoints = (ctx: TenantContext, i: z.infer<typeof pointsAdjustSchema>) =>
  call('restaurant_loyalty_adjust', { p_org: ctx.organizationId, p_phone: i.phone, p_points: i.points, p_note: i.note }, 'adjustPoints') as Promise<number>;

export const redeemSchema = z.object({ phone: z.string().trim().min(7).max(30), rewardId: z.string().uuid() });
export async function staffRedeem(ctx: TenantContext, i: z.infer<typeof redeemSchema>) {
  const d = (await call('restaurant_loyalty_staff_redeem', { p_org: ctx.organizationId, p_branch: ctx.branchId, p_phone: i.phone, p_reward: i.rewardId }, 'staffRedeem')) as Record<string, unknown>;
  return { code: String(d.code), valueCents: Number(d.value_cents), expiresAt: String(d.expires_at), reward: String(d.reward), balance: Number(d.balance) };
}

// ---------------------------------------------------------------------------
// House accounts
// ---------------------------------------------------------------------------
export type HouseAccount = {
  customerId: string; name: string; phone: string | null; limitCents: number; balanceCents: number;
  termsDays: number; isActive: boolean; contact: string | null; overdueCents: number;
};

export async function listAccounts(ctx: TenantContext): Promise<HouseAccount[]> {
  const rows = (await call('restaurant_accounts_list', { p_org: ctx.organizationId }, 'listAccounts')) as Record<string, unknown>[] | null;
  return (rows ?? []).map((r) => ({
    customerId: String(r.out_customer_id), name: String(r.out_name), phone: (r.out_phone as string) ?? null,
    limitCents: Number(r.out_limit_cents), balanceCents: Number(r.out_balance_cents), termsDays: Number(r.out_terms_days),
    isActive: Boolean(r.out_active), contact: (r.out_contact as string) ?? null, overdueCents: Number(r.out_overdue_cents),
  }));
}

const amount = z.coerce.number().int().min(1).max(100_000_000_000);
export const accountSchema = z.object({
  customerId: z.string().uuid().nullable(), name: z.string().trim().max(160).optional(), phone: z.string().trim().max(30).optional(),
  limitCents: z.coerce.number().int().min(0).max(100_000_000_000), termsDays: z.coerce.number().int().min(0).max(365),
  isActive: z.boolean().default(true), contact: z.string().trim().max(120).optional(), note: z.string().trim().max(500).optional(),
});
export async function saveAccount(ctx: TenantContext, i: z.infer<typeof accountSchema>) {
  let customerId = i.customerId;
  if (!customerId) {
    // A new account for a new (or found-by-phone) customer.
    if (!i.name || !i.phone) throw staffDbError({ code: '22023', message: 'اسم العميل ورقم الهاتف مطلوبان' }, 'saveAccount');
    customerId = (await call('restaurant_customer_upsert', { p_org: ctx.organizationId, p_branch: ctx.branchId, p_id: null, p_name: i.name, p_phone: i.phone, p_notes: null }, 'saveAccount customer')) as string;
  }
  await call('restaurant_account_save', { p_org: ctx.organizationId, p_customer: customerId, p_limit_cents: i.limitCents, p_terms_days: i.termsDays, p_active: i.isActive, p_contact: i.contact ?? null, p_note: i.note ?? null }, 'saveAccount');
  return customerId;
}

export const chargeSchema = z.object({ orderId: z.string().uuid(), customerId: z.string().uuid() });
export const chargeOrder = (ctx: TenantContext, i: z.infer<typeof chargeSchema>) =>
  call('restaurant_account_charge', { p_org: ctx.organizationId, p_order: i.orderId, p_customer: i.customerId }, 'chargeOrder') as Promise<{ invoice_id: string; amount_cents: number; balance_cents: number }>;

export const accountPaymentSchema = z.object({ customerId: z.string().uuid(), amountCents: amount, method: z.enum(['cash', 'card', 'transfer', 'wallet', 'other']), reference: z.string().trim().max(120).optional() });
export const receivePayment = (ctx: TenantContext, i: z.infer<typeof accountPaymentSchema>) =>
  call('restaurant_account_payment', { p_org: ctx.organizationId, p_branch: ctx.branchId, p_customer: i.customerId, p_amount: i.amountCents, p_method: i.method, p_reference: i.reference ?? null }, 'receivePayment');

export const accountAdjustSchema = z.object({ customerId: z.string().uuid(), amountCents: z.coerce.number().int().refine((n) => n !== 0, 'المبلغ لا يكون صفرًا'), note: z.string().trim().min(1, 'اكتب السبب').max(300) });
export const adjustAccount = (ctx: TenantContext, i: z.infer<typeof accountAdjustSchema>) =>
  call('restaurant_account_adjust', { p_org: ctx.organizationId, p_branch: ctx.branchId, p_customer: i.customerId, p_amount: i.amountCents, p_note: i.note }, 'adjustAccount');

export type Statement = {
  customer: { id: string; name: string; phone: string | null }; creditLimitCents: number; termsDays: number;
  from: string; to: string; openingCents: number; closingCents: number; balanceNowCents: number;
  entries: { id: number; at: string; kind: 'charge' | 'payment' | 'adjustment'; amountCents: number; note: string | null; orderNumber: string | null; invoiceNumber: string | null; balanceCents: number }[];
};
export async function getStatement(ctx: TenantContext, customerId: string, from: string, to: string): Promise<Statement> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('restaurant_account_statement' as never, { p_org: ctx.organizationId, p_customer: customerId, p_from: from, p_to: to } as never);
  if (error) throw toDataUnavailable(error, 'getStatement');
  const d = data as unknown as Record<string, unknown>;
  const c = d.customer as Record<string, unknown>;
  return {
    customer: { id: String(c.id), name: String(c.name), phone: (c.phone as string) ?? null },
    creditLimitCents: Number(d.credit_limit_cents), termsDays: Number(d.terms_days), from: String(d.from), to: String(d.to),
    openingCents: Number(d.opening_cents), closingCents: Number(d.closing_cents), balanceNowCents: Number(d.balance_now_cents),
    entries: ((d.entries ?? []) as Record<string, unknown>[]).map((e) => ({
      id: Number(e.id), at: String(e.at), kind: e.kind as Statement['entries'][number]['kind'], amountCents: Number(e.amount_cents),
      note: (e.note as string) ?? null, orderNumber: (e.order_number as string) ?? null, invoiceNumber: (e.invoice_number as string) ?? null,
      balanceCents: Number(e.balance_cents),
    })),
  };
}
