'use client';

import { createSupabaseBrowserClient } from '@/lib/supabase/client';

/**
 * Direct-to-Storage uploads, from the browser, under the signed-in member's
 * own session — no server route in the middle. RLS (0069/0072) is the only
 * gate: a path's first segment names the organization, and the
 * INSERT/UPDATE/DELETE policies check the caller is an ACTIVE member of
 * THAT organization — not a specific feature permission, since uploading a
 * file does not by itself attach its URL anywhere. Whichever screen calls
 * this (menu, branding, a site section) re-checks its own permission
 * (restaurant.menu.manage, branding.manage, site.manage, …) server-side
 * before writing the resulting URL into the row it actually belongs to.
 */

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];

export type MediaPurpose = 'logo' | 'banner' | 'product' | 'category' | 'bundle';

export function validateImageFile(file: File): string | null {
  if (!ALLOWED_TYPES.includes(file.type)) {
    return 'الصيغة غير مدعومة. استخدم JPG أو PNG أو WEBP أو GIF.';
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return 'حجم الملف أكبر من 8 ميجابايت.';
  }
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function uploadMedia(
  organizationId: string,
  purpose: MediaPurpose,
  file: File,
): Promise<{ url: string; path: string }> {
  const invalid = validateImageFile(file);
  if (invalid) throw new Error(invalid);

  // The path's first segment IS the RLS check (app.media_path_org reads it
  // straight back out) — a blank or malformed organizationId would silently
  // build a path no policy grants anyone, and Storage would report that as
  // the same generic RLS violation this function exists partly to explain.
  // Caught here, before the request, it is obviously a caller bug rather
  // than another report of the Storage policy itself being wrong.
  if (!UUID_RE.test(organizationId)) {
    throw new Error('تعذّر رفع الصورة: معرّف المنشأة غير صالح. أعد تحميل الصفحة وحاول مرة أخرى.');
  }

  const supabase = createSupabaseBrowserClient();
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const path = `${organizationId}/${purpose}/${crypto.randomUUID()}.${ext}`;

  const { error } = await supabase.storage.from('media').upload(path, file, {
    cacheControl: '31536000',
    upsert: false,
    contentType: file.type,
  });
  if (error) {
    // The RLS policies (0069/0072/0075) grant any ACTIVE organization member
    // full access to their own org's folder. Reaching this message today
    // almost always means the browser's session cookie is stale — expired or
    // signed out in another tab — not that the policy itself refused an
    // active member, so the fix on this side is to sign back in, not to
    // retry the same request.
    const isRls = /row-level security|row level security/i.test(error.message);
    throw new Error(
      isRls
        ? 'تعذّر رفع الصورة: يبدو أن جلستك انتهت. أعد تحميل الصفحة وسجّل الدخول مرة أخرى.'
        : error.message,
    );
  }

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
  const supabase = createSupabaseBrowserClient();
  await supabase.storage.from('media').remove([path]);
}
