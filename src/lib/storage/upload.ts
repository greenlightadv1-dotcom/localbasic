'use client';

import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { createMediaUploadTicket, deleteMediaAction } from './actions';
import { MAX_UPLOAD_BYTES, MEDIA_PURPOSES, validateImageFile, type MediaPurpose } from './media';

/**
 * Direct-to-Storage uploads, from the browser, under the signed-in member's
 * own session.
 *
 * The file bytes never pass through this application's server: a small
 * Server Action (createMediaUploadTicket, src/lib/storage/actions.ts) mints a
 * short-lived signed upload URL there, where the httpOnly session cookie is
 * actually readable, and Storage RLS (0069/0072/0075) is the real gate — any
 * ACTIVE member of the organization named by the path, not a specific
 * feature permission, since uploading a file does not by itself attach its
 * URL anywhere. Whichever screen calls this (menu, branding, a site section)
 * re-checks its own permission (restaurant.menu.manage, branding.manage, …)
 * server-side before writing the resulting URL into the row it actually
 * belongs to.
 *
 * Why not call `.storage.upload()` straight from the browser client, the way
 * this used to work: that client manages its session via document.cookie,
 * which this app's auth cookies are deliberately NOT readable from (httpOnly
 * — src/lib/supabase/server.ts). A direct browser upload therefore always
 * reaches Storage looking anonymous, RLS correctly refuses it, and the
 * result reads as "your session expired" even for an active member. Minting
 * the ticket server-side (where the cookie IS readable) fixes that without
 * giving up either the httpOnly session or the direct-to-Storage transfer
 * large images need.
 */

export { MAX_UPLOAD_BYTES, MEDIA_PURPOSES, validateImageFile, type MediaPurpose };

export async function uploadMedia(
  organizationId: string,
  purpose: MediaPurpose,
  file: File,
): Promise<{ url: string; path: string }> {
  const invalid = validateImageFile(file);
  if (invalid) throw new Error(invalid);

  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';

  const ticket = await createMediaUploadTicket({ organizationId, purpose, ext });
  if (!ticket.ok) {
    throw new Error(
      ticket.code === 'unauthenticated'
        ? 'تعذّر رفع الصورة: يبدو أن جلستك انتهت. أعد تحميل الصفحة وسجّل الدخول مرة أخرى.'
        : ticket.error,
    );
  }

  const supabase = createSupabaseBrowserClient();
  const { path, token } = ticket.data;

  const { error } = await supabase.storage
    .from('media')
    .uploadToSignedUrl(path, token, file, { contentType: file.type });
  if (error) throw new Error(`تعذّر رفع الصورة: ${error.message}`);

  const { data } = supabase.storage.from('media').getPublicUrl(path);
  return { url: data.publicUrl, path };
}

/**
 * Best-effort. A replaced or removed image leaving its old file in Storage
 * is a storage-quota problem, never a correctness one — nothing reads a
 * Storage object directly, only the URL column that pointed at it, and that
 * column is what actually changes. A failed delete here is swallowed by the
 * caller, not retried or surfaced.
 */
export async function deleteMediaByUrl(url: string): Promise<void> {
  const marker = '/object/public/media/';
  const at = url.indexOf(marker);
  if (at === -1) return;
  const path = decodeURIComponent(url.slice(at + marker.length));
  await deleteMediaAction({ path });
}
