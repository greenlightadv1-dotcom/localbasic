'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { resetOwnerPasswordAction, type OwnerPasswordState } from '../../actions';

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="h-10 rounded bg-primary px-4 text-sm font-semibold text-primary-fg hover:bg-primary/90 disabled:opacity-50"
    >
      {pending ? '…' : 'تعيين كلمة مرور مؤقتة'}
    </button>
  );
}

/**
 * The owner forgot their password and asked support on WhatsApp. The operator
 * types a temporary one here and sends it back; the owner is forced to replace
 * it on their next login.
 */
export function OwnerPasswordReset({ customerCode }: { customerCode: string }) {
  const [state, action] = useFormState<OwnerPasswordState, FormData>(resetOwnerPasswordAction, undefined);

  return (
    <form action={action} className="space-y-2 border-t border-line px-5 py-4">
      <input type="hidden" name="customerCode" value={customerCode} />
      <p className="text-xs font-bold text-fg">إعادة تعيين كلمة مرور المالك</p>
      {state?.error ? <p className="text-xs text-danger">{state.error}</p> : null}
      {state?.ok ? <p className="text-xs font-semibold text-success">{state.ok}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <input
          name="password"
          type="text"
          dir="ltr"
          required
          minLength={8}
          maxLength={72}
          autoComplete="off"
          placeholder="كلمة المرور المؤقتة"
          aria-label="كلمة المرور المؤقتة"
          className="h-10 w-56 rounded border border-line bg-elevated px-3 text-sm text-fg"
        />
        <Submit />
      </div>
    </form>
  );
}
