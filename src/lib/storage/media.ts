/**
 * Media upload constants shared between the browser (client-side, fast
 * feedback) and the server (the signed-upload-ticket action). Isomorphic —
 * no 'use client', no server-only, no Supabase client of its own.
 */

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];

export const MEDIA_PURPOSES = ['logo', 'banner', 'product', 'category', 'bundle'] as const;
export type MediaPurpose = (typeof MEDIA_PURPOSES)[number];

export function validateImageFile(file: { type: string; size: number }): string | null {
  if (!ALLOWED_TYPES.includes(file.type)) {
    return 'الصيغة غير مدعومة. استخدم JPG أو PNG أو WEBP أو GIF.';
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return 'حجم الملف أكبر من 8 ميجابايت.';
  }
  return null;
}
