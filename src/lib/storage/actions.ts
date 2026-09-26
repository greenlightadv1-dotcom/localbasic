'use server';

import { z } from 'zod';
import { defineUserAction } from '@/lib/action';
import { RATE_LIMITS } from '@/lib/rate-limit';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AppError, toAppError } from '@/lib/errors';
import { MEDIA_PURPOSES } from './media';

/**
 * The server half of a direct-to-Storage upload.
 *
 * The browser client (src/lib/supabase/client.ts) manages its Supabase
 * session through document.cookie, which this application's auth cookies are
 * deliberately NOT readable from (httpOnly — see src/lib/supabase/server.ts).
 * That is the right call for the session itself (an XSS payload should never
 * be able to read it out), but it means the browser client can never prove
 * who is signed in to Storage on its own, and a plain client-side
 * `.storage.upload()` call always looks like an anonymous request to Storage
 * RLS — reported back as "session expired" even for a genuinely active
 * member.
 *
 * The fix: mint the upload authorization HERE, server-side, where the same
 * httpOnly cookie IS readable (createSupabaseServerClient reads it via
 * next/headers, not document.cookie). `createSignedUploadUrl` performs the
 * exact same RLS check `.upload()` would have — any ACTIVE member of the
 * organization named by the path (0072/0075) — so authorization is still
 * entirely Storage's call, not this action's. Only the resulting short-lived
 * token travels back to the browser, which then uploads the actual file
 * bytes directly to Storage, never through this server at all — preserving
 * both the httpOnly session and the direct-upload path large images need.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ticketInputSchema = z.object({
  organizationId: z.string().trim().regex(UUID_RE, 'معرّف المنشأة غير صالح.'),
  purpose: z.enum(MEDIA_PURPOSES),
  ext: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]{1,8}$/)
    .default('jpg'),
});

export const createMediaUploadTicket = defineUserAction({
  schema: ticketInputSchema,
  rateLimit: RATE_LIMITS.mediaUpload,
  handler: async ({ input }) => {
    const supabase = createSupabaseServerClient();
    const path = `${input.organizationId}/${input.purpose}/${crypto.randomUUID()}.${input.ext}`;

    const { data, error } = await supabase.storage.from('media').createSignedUploadUrl(path);
    if (error) {
      // Reaching this means the caller is not an active member of this
      // organization — the same thing a direct upload's RLS check would
      // have refused, just caught one step earlier.
      throw new AppError('forbidden', 'ليست لديك صلاحية رفع الصور لهذه المنشأة.');
    }

    return { path: data.path, token: data.token };
  },
});

const deleteInputSchema = z.object({
  path: z.string().trim().min(1).max(500),
});

/**
 * Best-effort delete, same session-authenticated route as the upload ticket.
 * A replaced or removed image leaving its old file in Storage is a
 * storage-quota problem, never a correctness one, so the caller swallows
 * whatever this returns.
 */
export const deleteMediaAction = defineUserAction({
  schema: deleteInputSchema,
  rateLimit: RATE_LIMITS.mediaUpload,
  handler: async ({ input }) => {
    try {
      const supabase = createSupabaseServerClient();
      await supabase.storage.from('media').remove([input.path]);
    } catch (error) {
      toAppError(error, 'deleteMediaAction');
    }
    return { ok: true };
  },
});
