'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { defineTenantAction } from '@/lib/action';
import { createInvitation, revokeInvitation } from '@/modules/core/members/invitations';

/**
 * Invitations.
 *
 * `member.manage` is checked by the wrapper against the context resolved from
 * the URL, and again inside the database function. The accept link comes back
 * once and is returned to the inviter so they can hand it over directly; it is
 * never stored anywhere but as a hash.
 */

export const inviteMemberAction = defineTenantAction({
  schema: z.object({
    email: z.string().trim().email('أدخل بريدًا صحيحًا').max(200),
    roleIds: z.array(z.string().uuid()).max(20).default([]),
    allBranches: z.coerce.boolean().default(false),
    branchIds: z.array(z.string().uuid()).max(50).default([]),
  }),
  permission: 'member.manage',
  handler: async ({ ctx, input }) => {
    const result = await createInvitation(ctx, {
      email: input.email,
      roleIds: input.roleIds,
      branchIds: input.branchIds,
      allBranches: input.allBranches,
    });
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/settings/members`);
    return result;
  },
});

export const revokeInvitationAction = defineTenantAction({
  schema: z.object({ id: z.string().uuid() }),
  permission: 'member.manage',
  handler: async ({ ctx, input }) => {
    await revokeInvitation(ctx, input.id);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/settings/members`);
    return { ok: true };
  },
});
