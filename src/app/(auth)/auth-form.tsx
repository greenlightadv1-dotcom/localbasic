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
  mode,
}: {
  action: (state: AuthFormState, formData: FormData) => Promise<AuthFormState>;
  submitLabel: string;
  mode: 'sign-in' | 'sign-up';
}) {
  const [state, formAction] = useFormState(action, undefined);

  return (
    <form action={formAction} className="space-y-4">
      {state?.error && <Alert tone="danger">{state.error}</Alert>}

      {mode === 'sign-up' && (
        <Field label="الاسم بالكامل" required>
          {(p) => <Input {...p} name="fullName" autoComplete="name" required />}
        </Field>
      )}

      <Field label="البريد الإلكتروني" required>
        {(p) => <Input {...p} name="email" type="email" autoComplete="email" required dir="ltr" />}
      </Field>

      <Field
        label="كلمة المرور"
        required
        hint={mode === 'sign-up' ? '8 أحرف على الأقل' : undefined}
      >
        {(p) => (
          <Input
            {...p}
            name="password"
            type="password"
            autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
            minLength={8}
            required
            dir="ltr"
          />
        )}
      </Field>

      <SubmitButton label={submitLabel} />
    </form>
  );
}
