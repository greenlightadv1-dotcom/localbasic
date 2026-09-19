'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import type { AuthFormState } from './actions';

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" block size="lg" disabled={pending}>
      {pending ? 'جارٍ المعالجة…' : label}
    </Button>
  );
}

/** Ask for a recovery link. */
export function ForgotPasswordForm({
  action,
}: {
  action: (state: AuthFormState, formData: FormData) => Promise<AuthFormState>;
}) {
  const [state, formAction] = useFormState(action, undefined);

  // Once the notice is shown the form is done; leaving the field live invites
  // a second submit that only burns the rate limit.
  if (state?.notice) {
    return <Alert tone="success">{state.notice}</Alert>;
  }

  return (
    <form action={formAction} className="space-y-4">
      {state?.error && <Alert tone="danger">{state.error}</Alert>}

      <Field label="البريد الإلكتروني" required>
        {(p) => (
          <Input {...p} name="email" type="email" autoComplete="email" required dir="ltr" />
        )}
      </Field>

      <SubmitButton label="أرسل رابط الاستعادة" />
    </form>
  );
}

/** Set a new password against the session the recovery link produced. */
export function ResetPasswordForm({
  action,
}: {
  action: (state: AuthFormState, formData: FormData) => Promise<AuthFormState>;
}) {
  const [state, formAction] = useFormState(action, undefined);

  return (
    <form action={formAction} className="space-y-4">
      {state?.error && <Alert tone="danger">{state.error}</Alert>}

      <Field label="كلمة المرور الجديدة" required hint="8 أحرف على الأقل">
        {(p) => (
          <Input
            {...p}
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            dir="ltr"
          />
        )}
      </Field>

      <Field label="تأكيد كلمة المرور" required>
        {(p) => (
          <Input
            {...p}
            name="confirm"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            dir="ltr"
          />
        )}
      </Field>

      <SubmitButton label="حفظ كلمة المرور" />
    </form>
  );
}
