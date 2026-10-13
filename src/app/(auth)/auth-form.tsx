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

export function AuthForm({
  action,
  submitLabel,
}: {
  action: (state: AuthFormState, formData: FormData) => Promise<AuthFormState>;
  submitLabel: string;
}) {
  const [state, formAction] = useFormState(action, undefined);

  return (
    <form action={formAction} className="space-y-4">
      {state?.error && <Alert tone="danger">{state.error}</Alert>}

      <Field label="اسم المستخدم" required>
        {(p) => (
          <Input
            {...p}
            name="identifier"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            dir="ltr"
          />
        )}
      </Field>

      <Field label="كلمة المرور" required>
        {(p) => (
          <Input
            {...p}
            name="password"
            type="password"
            autoComplete="current-password"
            required
            dir="ltr"
          />
        )}
      </Field>

      <SubmitButton label={submitLabel} />
    </form>
  );
}
