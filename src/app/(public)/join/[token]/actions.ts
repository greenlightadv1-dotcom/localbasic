'use server';

import { acceptInvitation } from '@/modules/core/members/invitations';
import { AppError } from '@/lib/errors';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/action';

export type AcceptResult =
  | { ok: true; organizationSlug: string }
  | { ok: false; error: string };

/**
 * Accept an invitation.
 *
 * Not a tenant action: the caller is not a member yet, so there is no context
 * to resolve. The authorization is the pairing the database checks — this
 * token, and this signed-in address. Rate limited by IP because a token is the
 * kind of thing somebody tries to guess, even though guessing a 24-byte CSPRNG
 * value is not a realistic attack.
 */
export async function acceptInvitationAction(token: string): Promise<AcceptResult> {
  if (!checkRateLimit(`invite-accept:${getClientIp()}`, RATE_LIMITS.signIn).ok) {
    return { ok: false, error: 'محاولات كثيرة. انتظر قليلًا ثم أعد المحاولة.' };
  }

  try {
    const result = await acceptInvitation(token);
    return { ok: true, organizationSlug: result.organizationSlug };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof AppError ? error.message : 'تعذّر قبول الدعوة.',
    };
  }
}
