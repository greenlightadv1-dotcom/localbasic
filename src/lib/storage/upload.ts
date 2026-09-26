'use client';

import { createSupabaseBrowserClient } from '@/lib/supabase/client';

/**
 * Direct-to-Storage uploads, from the browser, under the signed-in member's
 * own session — no server route in the middle. RLS (0069_media_storage.sql)
 * is the only gate: a path's first segment names the organization, and the
 * INSERT/UPDATE/DELETE policies check the caller holds branding.manage,
 * site.manage or restaurant.menu.manage on THAT organization. Nothing here
 * re-checks that; a member the database would refuse gets the database's
 * error, not a client-side illusion of success.
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

export async function uploadMedia(
  organizationId: string,
  purpose: MediaPurpose,
  file: File,
): Promise<{ url: string; path: string }> {
  const invalid = validateImageFile(file);
  if (invalid) throw new Error(invalid);

  const supabase = createSupabaseBrowserClient();
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const path = `${organizationId}/${purpose}/${crypto.randomUUID()}.${ext}`;

  const { error } = await supabase.storage.from('media').upload(path, file, {
    cacheControl: '31536000',
    upsert: false,
    contentType: file.type,
  });
  if (error) throw new Error(error.message);

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
