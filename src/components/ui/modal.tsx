'use client';

import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

/**
 * A form-sized modal on <dialog>: the browser traps focus, handles Escape and
 * draws the backdrop. Body scrolls; header and footer stay put. Escape and the
 * close button both go through onClose, so the parent stays the one owner of
 * `open`.
 */
export function Modal({
  open,
  title,
  description,
  icon: Icon,
  size = 'md',
  onClose,
  footer,
  children,
  busy,
  testId,
}: {
  open: boolean;
  title: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string }>;
  size?: 'sm' | 'md' | 'lg';
  onClose: () => void;
  footer?: React.ReactNode;
  children: React.ReactNode;
  /** While true, Escape and the close button do nothing. */
  busy?: boolean;
  testId?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}
      aria-labelledby={testId ? `${testId}-title` : undefined}
      data-testid={testId}
      className={cn(
        'rounded-lg border border-line bg-elevated p-0 text-fg backdrop:bg-fg/40',
        size === 'sm' && 'w-[min(26rem,calc(100vw-1rem))]',
        size === 'md' && 'w-[min(36rem,calc(100vw-1rem))]',
        size === 'lg' && 'w-[min(48rem,calc(100vw-1rem))]',
      )}
    >
      {open && (
        <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
          <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
            <div className="space-y-1">
              <h2 id={testId ? `${testId}-title` : undefined} className="flex items-center gap-2 text-base font-bold">
                {Icon && <Icon className="h-5 w-5 text-primary" />}
                {title}
              </h2>
              {description && <p className="text-sm text-muted">{description}</p>}
            </div>
            <Button size="icon" variant="ghost" onClick={onClose} disabled={busy} aria-label="إغلاق">
              <X className="h-5 w-5" />
            </Button>
          </header>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-4">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}
