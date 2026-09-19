'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  archiveWebsite,
  createWebsite,
  publishWebsite,
  saveBrief,
} from '@/modules/platform/websites/service';
import { AppError } from '@/lib/errors';

/**
 * Website Builder actions.
 *
 * Each one hands a plain object to the service and lets the service decide.
 * No action reads the database, resolves an organization or trusts a field
 * that names an actor: the organization is verified server-side from its id,
 * and authorship is set by the database from auth.uid() whatever the form
 * carried. requirePlatformAdmin() runs inside every service call, so a tenant
 * user posting straight at these gets the same 404 the pages give them.
 */

export type WebsiteState = { error?: string; ok?: string } | undefined;

function message(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

function list(formData: FormData, field: string): string[] {
  return String(formData.get(field) ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 20);
}

export async function createWebsiteAction(
  _prev: WebsiteState,
  formData: FormData,
): Promise<WebsiteState> {
  let id: string;
  try {
    id = await createWebsite({
      organizationId: String(formData.get('organizationId') ?? ''),
      name: String(formData.get('name') ?? '').trim(),
      slug: String(formData.get('slug') ?? '').trim(),
      siteType: String(formData.get('siteType') ?? ''),
      locale: String(formData.get('locale') ?? 'ar'),
      brief: {
        notes: String(formData.get('notes') ?? '').trim(),
        audience: String(formData.get('audience') ?? '').trim() || undefined,
        tone: String(formData.get('tone') ?? '').trim() || undefined,
        requestedPages: list(formData, 'requestedPages'),
        requestedSections: list(formData, 'requestedSections'),
        seoKeywords: list(formData, 'seoKeywords'),
        restrictions: String(formData.get('restrictions') ?? '').trim() || undefined,
      },
    });
  } catch (error) {
    return { error: message(error, 'تعذّر إنشاء الموقع.') };
  }

  // Outside the try: redirect() works by throwing, and catching it here would
  // turn a successful creation into an error message.
  revalidatePath('/admin/websites');
  redirect(`/admin/websites/${id}`);
}

export async function publishWebsiteAction(
  _prev: WebsiteState,
  formData: FormData,
): Promise<WebsiteState> {
  const id = String(formData.get('id') ?? '');
  try {
    const { version, pageCount } = await publishWebsite(
      id,
      String(formData.get('note') ?? '').trim() || undefined,
    );
    revalidatePath(`/admin/websites/${id}`);
    revalidatePath('/admin/websites');
    return { ok: `تم نشر الإصدار ${version} (${pageCount} صفحة).` };
  } catch (error) {
    return { error: message(error, 'تعذّر النشر.') };
  }
}

export async function archiveWebsiteAction(
  _prev: WebsiteState,
  formData: FormData,
): Promise<WebsiteState> {
  const id = String(formData.get('id') ?? '');
  try {
    await archiveWebsite(id);
    revalidatePath(`/admin/websites/${id}`);
    revalidatePath('/admin/websites');
    return { ok: 'تمت أرشفة الموقع. المحتوى المنشور محفوظ.' };
  } catch (error) {
    return { error: message(error, 'تعذّرت الأرشفة.') };
  }
}

export async function saveBriefAction(
  _prev: WebsiteState,
  formData: FormData,
): Promise<WebsiteState> {
  const id = String(formData.get('id') ?? '');
  try {
    await saveBrief(id, {
      notes: String(formData.get('notes') ?? '').trim(),
      audience: String(formData.get('audience') ?? '').trim() || undefined,
      tone: String(formData.get('tone') ?? '').trim() || undefined,
      requestedPages: list(formData, 'requestedPages'),
      requestedSections: list(formData, 'requestedSections'),
      seoKeywords: list(formData, 'seoKeywords'),
      restrictions: String(formData.get('restrictions') ?? '').trim() || undefined,
    });
    revalidatePath(`/admin/websites/${id}`);
    return { ok: 'تم حفظ التعليمات.' };
  } catch (error) {
    return { error: message(error, 'تعذّر الحفظ.') };
  }
}
