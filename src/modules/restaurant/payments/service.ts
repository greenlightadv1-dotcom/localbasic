import 'server-only';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AppError, toAppError } from '@/lib/errors';
import { sealSecret, SecretBoxUnavailableError } from '@/lib/crypto/secret-box';
import { requirePermission, type TenantContext } from '@/modules/core/tenancy/context';
import { GATEWAYS, ONLINE_CHECKOUT_LIVE, isGatewayKey, type GatewayKey } from './gateways';
import type { PaymentOptions } from './options';

export type PaymentSettings = {
  cashEnabled: boolean;
  onlineEnabled: boolean;
  gateway: GatewayKey | null;
  /** Non-secret identifiers only. Secrets are never read back. */
  publicConfig: Record<string, string>;
  hasSecret: boolean;
  secretHint: string | null;
  /** Whether the current plan includes a custom online gateway. */
  planAllowsOnline: boolean;
};

export const savePaymentSettingsSchema = z.object({
  cashEnabled: z.boolean(),
  onlineEnabled: z.boolean(),
  gateway: z.string().trim().max(32).nullable().optional(),
  /** Public identifiers and any NEW secret values, keyed by field. */
  values: z.record(z.string().max(60), z.string().max(500)).default({}),
  clearSecret: z.boolean().default(false),
});
export type SavePaymentSettingsInput = z.infer<typeof savePaymentSettingsSchema>;

export async function getPaymentSettings(ctx: TenantContext): Promise<PaymentSettings> {
  requirePermission(ctx, 'settings.manage');
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .rpc('restaurant_payment_settings_get', { p_org: ctx.organizationId })
    .single();
  if (error) throw toAppError(error, 'getPaymentSettings');
  const row = data as unknown as {
    out_cash_enabled: boolean; out_online_enabled: boolean; out_gateway: string | null;
    out_public_config: Record<string, string>; out_has_secret: boolean;
    out_secret_hint: string | null; out_plan_allows: boolean;
  };
  return {
    cashEnabled: row.out_cash_enabled,
    onlineEnabled: row.out_online_enabled,
    gateway: isGatewayKey(row.out_gateway) ? row.out_gateway : null,
    publicConfig: row.out_public_config ?? {},
    hasSecret: row.out_has_secret,
    secretHint: row.out_secret_hint,
    planAllowsOnline: row.out_plan_allows,
  };
}

export async function savePaymentSettings(
  ctx: TenantContext,
  input: SavePaymentSettingsInput,
): Promise<void> {
  requirePermission(ctx, 'settings.manage');
  const gateway = input.gateway ? input.gateway : null;
  if (gateway !== null && !isGatewayKey(gateway)) {
    throw new AppError('validation', 'بوابة الدفع غير معروفة');
  }
  // Cash is the only method guests can actually complete today; turning it
  // off would leave them no way to order.
  if (!input.cashEnabled && !ONLINE_CHECKOUT_LIVE) {
    throw new AppError('validation', 'لا يمكن إيقاف الدفع النقدي قبل تفعيل معالجة الدفع الإلكتروني في صفحة الطلب.');
  }

  let publicConfig: Record<string, string> = {};
  let ciphertext: string | null = null;
  let hint: string | null = null;

  if (gateway !== null) {
    const def = GATEWAYS[gateway];
    const publicFields = def.fields.filter((f) => !f.secret);
    const secretFields = def.fields.filter((f) => f.secret);

    for (const f of publicFields) {
      const v = (input.values[f.key] ?? '').trim();
      if (v) publicConfig[f.key] = v;
    }

    const provided = secretFields.filter((f) => (input.values[f.key] ?? '').trim() !== '');
    if (provided.length > 0) {
      // Secrets are replaced as a set: a half-updated pair is how a store ends
      // up with a key from one account and a secret from another.
      if (provided.length !== secretFields.length) {
        throw new AppError('validation', 'أدخل كل المفاتيح السرية معًا لتحديثها.');
      }
      const secrets: Record<string, string> = {};
      for (const f of secretFields) secrets[f.key] = (input.values[f.key] ?? '').trim();
      try {
        ciphertext = sealSecret(JSON.stringify(secrets));
      } catch (error) {
        if (error instanceof SecretBoxUnavailableError) {
          throw new AppError('internal', 'تخزين المفاتيح غير مُفعّل على الخادم. تواصل مع الدعم لإضافة مفتاح التشفير.');
        }
        throw error;
      }
      const first = secrets[secretFields[0]!.key]!;
      hint = `••••${first.slice(-4)}`;
    }
  } else {
    publicConfig = {};
  }

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('restaurant_payment_settings_save', {
    p_org: ctx.organizationId,
    p_cash_enabled: input.cashEnabled,
    p_online_enabled: input.onlineEnabled,
    p_gateway: gateway,
    p_public_config: publicConfig,
    p_secret_ciphertext: ciphertext,
    p_secret_hint: hint,
    p_clear_secret: input.clearSecret || gateway === null,
  });
  if (error) throw toAppError(error, 'savePaymentSettings');
}

function toOptions(data: unknown): PaymentOptions {
  const row = (Array.isArray(data) ? data[0] : data) as
    | { out_cash: boolean; out_online_gateway: string | null }
    | undefined;
  const gateway = row && isGatewayKey(row.out_online_gateway) ? row.out_online_gateway : null;
  return {
    cash: row ? row.out_cash : true,
    online: gateway ? { gateway, label: GATEWAYS[gateway].label, live: ONLINE_CHECKOUT_LIVE } : null,
  };
}

/** Never throws: a failed read degrades to "cash only", the safe default. */
export async function getPublicPaymentOptions(orgSlug: string): Promise<PaymentOptions> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('restaurant_payment_options', { p_org_slug: orgSlug });
  return error ? { cash: true, online: null } : toOptions(data);
}

export async function getPublicPaymentOptionsByToken(token: string): Promise<PaymentOptions> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('restaurant_payment_options_by_token', { p_token: token });
  return error ? { cash: true, online: null } : toOptions(data);
}
