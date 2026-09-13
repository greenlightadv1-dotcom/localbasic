import { forwardRef, useId } from 'react';
import { cn } from '@/lib/cn';

const control =
  'h-11 w-full rounded border border-line bg-elevated px-3 text-sm text-fg ' +
  'placeholder:text-muted/70 transition-colors focus:border-primary ' +
  'disabled:bg-surface disabled:text-muted';

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => <input ref={ref} className={cn(control, className)} {...props} />,
);
Input.displayName = 'Input';

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => (
    <select ref={ref} className={cn(control, 'cursor-pointer', className)} {...props} />
  ),
);
Select.displayName = 'Select';

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(control, 'h-auto min-h-24 py-2', className)} {...props} />
));
Textarea.displayName = 'Textarea';

/**
 * Every control is labelled and every error is associated with its input via
 * aria-describedby — a screen reader announces the problem, not just the field.
 */
export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string[];
  required?: boolean;
  children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => React.ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error?.length ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-fg">
        {label}
        {required && <span className="text-danger" aria-hidden="true"> *</span>}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': Boolean(errorId) })}
      {hint && !errorId && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {errorId && (
        <p id={errorId} className="text-xs font-medium text-danger">
          {error?.join('، ')}
        </p>
      )}
    </div>
  );
}
