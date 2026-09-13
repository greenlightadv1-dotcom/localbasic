'use client';

import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Confirmation for anything destructive or hard to undo — cancelling an order,
 * rotating a QR that is already printed.
 *
 * Built on <dialog>, so focus trapping, Escape to dismiss and the backdrop are
 * the browser's job rather than ours.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'تأكيد',
  cancelLabel = 'إلغاء',
  tone = 'danger',
  busy,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onCancel}
      onCancel={onCancel}
      aria-labelledby="confirm-title"
      className="w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-line bg-elevated p-0 text-fg backdrop:bg-fg/40"
    >
      <div className="space-y-4 p-5">
        <div className="space-y-1">
          <h2 id="confirm-title" className="text-base font-bold">
            {title}
          </h2>
          {description && <p className="text-sm text-muted">{description}</p>}
        </div>
        {children}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy}>
            {busy ? '…' : confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
