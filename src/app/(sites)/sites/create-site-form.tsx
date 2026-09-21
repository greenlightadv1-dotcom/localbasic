'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { suggestSiteSlug } from '@/modules/sites/schemas';
import { createSiteAction, type CreateSiteState } from './actions';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'جارٍ الإنشاء…' : 'إنشاء الموقع'}
    </Button>
  );
}

/**
 * Create a site.
 *
 * The slug is suggested from the name but stays editable, and once the user
 * has edited it the suggestion stops overwriting their choice — a field that
 * rewrites itself as you type above it is worse than no suggestion at all.
 */
export function CreateSiteForm() {
  const [state, formAction] = useFormState<CreateSiteState, FormData>(
    createSiteAction,
    undefined,
  );
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);

  return (
    <form action={formAction} className="space-y-4">
      {state?.error && <Alert tone="danger">{state.error}</Alert>}

      <Field label="اسم الموقع" required error={state?.fieldErrors?.name}>
        {(p) => (
          <Input
            {...p}
            name="name"
            required
            maxLength={120}
            placeholder="مقهى الحارة"
            onChange={(e) => {
              if (!slugTouched) setSlug(suggestSiteSlug(e.target.value));
            }}
          />
        )}
      </Field>

      <Field
        label="المعرّف"
        required
        hint="حروف إنجليزية صغيرة وأرقام وشرطات فقط، من ٣ إلى ٥٠ حرفًا."
        error={state?.fieldErrors?.slug}
      >
        {(p) => (
          <Input
            {...p}
            name="slug"
            required
            dir="ltr"
            value={slug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
            placeholder="my-cafe"
          />
        )}
      </Field>

      <SubmitButton />
    </form>
  );
}
