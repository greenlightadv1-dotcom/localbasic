import type { GatewayKey } from './gateways';

/** What a guest is offered at checkout. Carries no credentials. */
export type PaymentOptions = {
  cash: boolean;
  online: { gateway: GatewayKey; label: string; live: boolean } | null;
};
