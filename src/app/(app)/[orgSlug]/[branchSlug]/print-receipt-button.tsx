'use client';

import { useState } from 'react';
import { Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { buildReceiptHtml } from '@/lib/print/receipt-html';
import { printHtml } from '@/lib/print/print-html';
import { getReceiptAction } from './restaurant-actions';

/**
 * "طباعة الإيصال": fetches the receipt from the server (the database's own
 * record of the sale), formats it for an 80mm roll and opens the print dialog
 * for the device's receipt printer — without leaving the screen it is on, so
 * the cashier's cart, open dialogs and typed amounts stay exactly as they were.
 */
export function PrintReceiptButton({
  organizationSlug,
  branchSlug,
  invoiceId,
  label = 'طباعة الإيصال',
  variant = 'outline',
  size = 'sm',
}: {
  organizationSlug: string;
  branchSlug: string;
  invoiceId: string;
  label?: string;
  variant?: 'primary' | 'outline' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function print() {
    setBusy(true);
    try {
      const result = await getReceiptAction({ organizationSlug, branchSlug }, { invoiceId });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const printed = await printHtml(buildReceiptHtml(result.data));
      if (!printed.ok) toast.error(printed.error);
    } catch {
      toast.error('تعذّر تجهيز الإيصال للطباعة. حاول مرة أخرى.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      disabled={busy}
      onClick={print}
      data-testid="print-receipt"
    >
      <Printer className="h-4 w-4" aria-hidden="true" />
      {busy ? 'جارٍ التجهيز…' : label}
    </Button>
  );
}
