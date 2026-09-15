'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { setServiceAvailabilityAction, type ServiceState } from '../actions';

function Submit({ label, tone }: { label: string; tone: 'on' | 'off' }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={
        tone === 'on'
          ? 'h-9 rounded bg-primary px-4 text-xs font-semibold text-primary-fg hover:bg-primary/90 disabled:opacity-50'
          : 'h-9 rounded border border-line bg-elevated px-4 text-xs font-semibold text-fg hover:bg-surface disabled:opacity-50'
      }
    >
      {pending ? '…' : label}
    </button>
  );
}

export function AvailabilityToggle({
  moduleKey,
  isAvailable,
  disabled,
}: {
  moduleKey: string;
  isAvailable: boolean;
  disabled: boolean;
}) {
  const [state, action] = useFormState<ServiceState, FormData>(
    setServiceAvailabilityAction,
    undefined,
  );

  if (disabled) {
    return <span className="text-xs text-muted">غير متاح — الخدمة لم تُبنَ بعد.</span>;
  }

  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="moduleKey" value={moduleKey} />
      <input type="hidden" name="isAvailable" value={isAvailable ? 'false' : 'true'} />
      <Submit
        label={isAvailable ? 'إيقاف البيع' : 'إتاحة للبيع'}
        tone={isAvailable ? 'off' : 'on'}
      />
      {state?.error ? <span className="text-xs text-danger">{state.error}</span> : null}
      {state?.ok ? <span className="text-xs text-success">{state.ok}</span> : null}
    </form>
  );
}
