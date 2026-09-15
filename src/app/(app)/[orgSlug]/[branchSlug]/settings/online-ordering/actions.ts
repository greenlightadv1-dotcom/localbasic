'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { resolveTenantContext } from '@/modules/core/tenancy/context';
import { saveOnlineSettings } from '@/modules/restaurant/online/settings';
import { AppError } from '@/lib/errors';

export type SettingsState = { error?: string; ok?: string } | undefined;

/**
 * Save the online ordering settings.
 *
 * The tenant context is resolved from the URL, never from the form, and
 * saveOnlineSettings re-checks `settings.manage` before writing. A form that
 * posts a different organization gets nowhere.
 */
export async function saveOnlineSettingsAction(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const orgSlug = String(formData.get('orgSlug') ?? '');
  const branchSlug = String(formData.get('branchSlug') ?? '');

  try {
    const ctx = await resolveTenantContext(orgSlug, branchSlug);
    await saveOnlineSettings(ctx, {
      enabled: formData.get('enabled') === 'on',
      pickupEnabled: formData.get('pickupEnabled') === 'on',
      deliveryEnabled: formData.get('deliveryEnabled') === 'on',
      deliveryFee: String(formData.get('deliveryFee') ?? '0'),
      scope: String(formData.get('scope') ?? 'branch'),
    });
  } catch (error) {
    return { error: error instanceof AppError ? error.message : 'تعذّر حفظ الإعدادات.' };
  }

  revalidatePath(`/${orgSlug}/${branchSlug}/settings/online-ordering`);

  // Revalidating re-renders the page this form sits on, which drops the
  // useFormState message — an operator would toggle a switch and see nothing.
  // The flag in the URL survives that. redirect() throws NEXT_REDIRECT, so it
  // stays outside the try above which would report a failure for a saved form.
  redirect(`/${orgSlug}/${branchSlug}/settings/online-ordering?saved=1`);
}
