import { Banknote, CreditCard } from 'lucide-react';
import type { PaymentOptions } from '@/modules/restaurant/payments/options';
import { CASH_LABEL } from '@/modules/restaurant/payments/gateways';

/**
 * The payment methods this store offers, as the guest sees them at checkout.
 *
 * Driven entirely by the store's saved settings (see getPublicPaymentOptions)
 * — never hard-coded. Cash is the only method that can be completed today, so
 * it is the selected one; a configured online gateway is listed but disabled
 * ("coming soon") until its checkout adapter ships (ONLINE_CHECKOUT_LIVE).
 */
export function PaymentOptionsList({ options }: { options: PaymentOptions }) {
  return (
    <fieldset className="space-y-2" aria-label="طريقة الدفع">
      <legend className="mb-1.5 text-sm font-semibold text-fg">طريقة الدفع</legend>

      {options.cash ? (
        <div className="flex items-center gap-3 rounded-[13px] border-2 border-primary bg-primary-soft p-3">
          <Banknote className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
          <span className="flex-1 text-sm font-semibold text-fg">{CASH_LABEL}</span>
          <span className="h-4 w-4 rounded-full border-4 border-primary bg-bg" aria-hidden="true" />
        </div>
      ) : null}

      {options.online ? (
        <div
          aria-disabled="true"
          className="flex items-center gap-3 rounded-[13px] border border-line bg-surface p-3 opacity-70"
        >
          <CreditCard className="h-5 w-5 shrink-0 text-muted" aria-hidden="true" />
          <span className="flex-1 text-sm font-semibold text-fg">
            بطاقة / محفظة إلكترونية
            <span className="block text-xs font-normal text-muted">{options.online.label}</span>
          </span>
          {!options.online.live ? (
            <span className="rounded-full bg-line px-2 py-0.5 text-xs text-muted">قريبًا</span>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}
