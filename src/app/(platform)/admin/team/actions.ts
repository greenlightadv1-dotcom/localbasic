'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { grantPlatformAdmin, revokePlatformAdmin } from '@/modules/platform/admin/roster';
import { AppError } from '@/lib/errors';

/**
 * Roster mutations.
 *
 * Neither of these is a tenant action, so they do not go through
 * `defineTenantAction` — there is no organization, no branch and no tenant
 * permission involved. The authorization that matters is in the database:
 * both functions require an active platform OWNER and refuse otherwise.
 *
 * Success redirects rather than returning a value, because `revalidatePath`
 * re-renders the page and the form state does not survive it. A refusal has
 * nothing to revalidate, so it comes back as state and the form can show it —
 * the same split the domains screens use.
 */

export type RosterState = { error?: string; ok?: boolean } | undefined;

const grantSchema = z.object({
  email: z.string().trim().email('أدخل بريدًا صحيحًا').max(200),
  role: z.enum(['owner', 'staff']),
  note: z.string().trim().max(300).optional().or(z.literal('')),
});

export async function grantAdminAction(
  _prev: RosterState,
  formData: FormData,
): Promise<RosterState> {
  const parsed = grantSchema.safeParse({
    email: formData.get('email') ?? '',
    role: formData.get('role') ?? 'staff',
    note: formData.get('note') ?? '',
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'بيانات غير صالحة' };
  }

  try {
    await grantPlatformAdmin(parsed.data.email, parsed.data.role, parsed.data.note);
  } catch (error) {
    return { error: error instanceof AppError ? error.message : 'تعذّر منح الصلاحية.' };
  }

  revalidatePath('/admin/team');
  redirect('/admin/team?granted=1');
}

export async function revokeAdminAction(
  _prev: RosterState,
  formData: FormData,
): Promise<RosterState> {
  const userId = String(formData.get('userId') ?? '');
  if (!z.string().uuid().safeParse(userId).success) return { error: 'طلب غير صالح' };

  try {
    await revokePlatformAdmin(userId);
  } catch (error) {
    return { error: error instanceof AppError ? error.message : 'تعذّر سحب الصلاحية.' };
  }

  revalidatePath('/admin/team');
  redirect('/admin/team?revoked=1');
}
