'use server';

import { placeOrder, quoteCart } from '@/modules/retail/store/service';
import { AppError } from '@/lib/errors';
import type { CheckoutInput, QuoteInput } from '@/modules/retail/store/schemas';

/**
 * The storefront's two writes to the server.
 *
 * Both are anonymous, so neither takes a tenant context: the shop is named by
 * its public slugs and resolved inside the database. Failures come back as
 * data — a storefront that throws across the boundary shows a stranger a stack
 * trace.
 */

export type QuoteResult =
  | { ok: true; subtotalCents: number; taxCents: number; feeCents: number; totalCents: number; minOrderCents: number }
  | { ok: false; error: string };

export async function quoteCartAction(input: QuoteInput): Promise<QuoteResult> {
  try {
    const quote = await quoteCart(input);
    if (!quote) return { ok: false, error: 'تعذّر حساب السلة.' };
    return {
      ok: true,
      subtotalCents: quote.subtotalCents,
      taxCents: quote.taxCents,
      feeCents: quote.feeCents,
      totalCents: quote.totalCents,
      minOrderCents: quote.minOrderCents,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof AppError ? error.message : 'تعذّر حساب السلة.',
    };
  }
}

export type CheckoutResult =
  | { ok: true; number: string; token: string; totalCents: number }
  | { ok: false; error: string };

export async function checkoutAction(input: CheckoutInput): Promise<CheckoutResult> {
  try {
    const order = await placeOrder(input);
    return {
      ok: true,
      number: order.number,
      token: order.token,
      totalCents: order.totalCents,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof AppError ? error.message : 'تعذّر إتمام الطلب.',
    };
  }
}
