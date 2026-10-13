'use client';

import { useLiveOrders } from './use-live-orders';

/**
 * For server-rendered pages with no client component of their own (the orders
 * list): drop it in and the page refreshes itself. Renders nothing.
 */
export function LiveOrders({ branchId, scope }: { branchId: string; scope: string }) {
  useLiveOrders(branchId, scope);
  return null;
}
