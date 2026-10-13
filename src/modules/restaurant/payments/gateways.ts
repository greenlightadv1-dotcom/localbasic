/**
 * The online gateways a store can connect, and what each one needs.
 *
 * Pure data, safe in client components. A field is either PUBLIC (an
 * identifier or publishable key: stored readable, shown back to the owner) or
 * SECRET (stored only inside one encrypted blob and never shown again).
 */
export const GATEWAY_KEYS = ['paymob', 'myfatoorah', 'tap', 'stripe'] as const;
export type GatewayKey = (typeof GATEWAY_KEYS)[number];

export type GatewayField = {
  key: string;
  label: string;
  secret: boolean;
  placeholder?: string;
};

export type GatewayDefinition = {
  key: GatewayKey;
  label: string;
  hint: string;
  fields: GatewayField[];
};

export const GATEWAYS: Record<GatewayKey, GatewayDefinition> = {
  paymob: {
    key: 'paymob',
    label: 'Paymob',
    hint: 'بطاقات ومحافظ إلكترونية في مصر.',
    fields: [
      { key: 'public_key', label: 'Public Key', secret: false, placeholder: 'egy_pk_live_…' },
      { key: 'integration_id', label: 'Integration ID', secret: false, placeholder: '1234567' },
      { key: 'secret_key', label: 'Secret Key', secret: true, placeholder: 'egy_sk_live_…' },
      { key: 'hmac_secret', label: 'HMAC Secret', secret: true },
    ],
  },
  myfatoorah: {
    key: 'myfatoorah',
    label: 'MyFatoorah',
    hint: 'بوابة دفع للخليج ومصر.',
    fields: [
      { key: 'merchant_id', label: 'Merchant ID', secret: false },
      { key: 'api_key', label: 'API Key (Token)', secret: true },
    ],
  },
  tap: {
    key: 'tap',
    label: 'Tap Payments',
    hint: 'بطاقات ومدفوعات محلية في الخليج.',
    fields: [
      { key: 'merchant_id', label: 'Merchant ID', secret: false },
      { key: 'public_key', label: 'Public Key', secret: false, placeholder: 'pk_live_…' },
      { key: 'secret_key', label: 'Secret Key', secret: true, placeholder: 'sk_live_…' },
    ],
  },
  stripe: {
    key: 'stripe',
    label: 'Stripe',
    hint: 'بطاقات دولية.',
    fields: [
      { key: 'public_key', label: 'Publishable Key', secret: false, placeholder: 'pk_live_…' },
      { key: 'secret_key', label: 'Secret Key', secret: true, placeholder: 'sk_live_…' },
    ],
  },
};

export function isGatewayKey(value: unknown): value is GatewayKey {
  return typeof value === 'string' && (GATEWAY_KEYS as readonly string[]).includes(value);
}

/**
 * Online card/wallet checkout is configured here but NOT yet processed: no
 * gateway adapter exists, so a guest cannot actually pay online. Until one
 * ships, the storefront shows the online option as "coming soon" and cash
 * cannot be turned off (that would leave guests with no way to order).
 * Flip this only together with the adapter.
 */
export const ONLINE_CHECKOUT_LIVE = false;

export const CASH_LABEL = 'الدفع نقدًا (عند الاستلام / على الطاولة)';
