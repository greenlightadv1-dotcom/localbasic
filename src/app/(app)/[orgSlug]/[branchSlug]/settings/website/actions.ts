'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { resolveTenantContext } from '@/modules/core/tenancy/context';
import { saveWebsiteSettings } from '@/modules/restaurant/website/settings';
import { AppError } from '@/lib/errors';

export type WebsiteState = { error?: string } | undefined;

export async function saveWebsiteAction(
  _prev: WebsiteState,
  formData: FormData,
): Promise<WebsiteState> {
  const orgSlug = String(formData.get('orgSlug') ?? '');
  const branchSlug = String(formData.get('branchSlug') ?? '');

  const hours = Array.from({ length: 7 }, (_, i) => ({
    closed: formData.get(`closed-${i}`) === 'on',
    opens: String(formData.get(`opens-${i}`) ?? ''),
    closes: String(formData.get(`closes-${i}`) ?? ''),
  }));

  try {
    // The tenant comes from the URL and is re-authorized inside the service;
    // the form contributes content only.
    const ctx = await resolveTenantContext(orgSlug, branchSlug);
    await saveWebsiteSettings(ctx, {
      enabled: formData.get('enabled') === 'on',
      tagline: String(formData.get('tagline') ?? ''),
      about: String(formData.get('about') ?? ''),
      heroUrl: String(formData.get('heroUrl') ?? ''),
      hours,
    });
  } catch (error) {
    return { error: error instanceof AppError ? error.message : 'تعذّر حفظ الإعدادات.' };
  }

  // The form now lives on the unified Site Customizer (settings/branding),
  // not its own settings/website screen.
  revalidatePath(`/${orgSlug}/${branchSlug}/settings/branding`);
  // Revalidating remounts the form and drops the useFormState message, so the
  // confirmation travels in the URL instead. redirect() throws NEXT_REDIRECT
  // and must stay outside the try above.
  redirect(`/${orgSlug}/${branchSlug}/settings/branding?saved=1`);
}
