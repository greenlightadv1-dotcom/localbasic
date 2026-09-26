'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { defineTenantAction } from '@/lib/action';
import { createMemberDirect } from '@/modules/core/members/direct';
import { removeMember } from '@/modules/core/members/remove';

/**
 * Staff accounts are created directly, not by email invitation — see
 * createMemberDirectAction below. There is no invite-creation action here
 * any more; `member.manage` is still checked by the wrapper against the
 * context resolved from the URL, and again inside the database function.
 */

export const createMemberDirectAction = defineTenantAction({
  schema: z.object({
    email: z.string().trim().email('أدخل بريدًا صحيحًا').max(200),
    password: z.string().min(8, 'كلمة المرور 8 أحرف على الأقل').max(72),
    fullName: z.string().trim().min(2, 'الاسم مطلوب').max(120),
    roleIds: z.array(z.string().uuid()).max(20).default([]),
    allBranches: z.coerce.boolean().default(false),
    branchIds: z.array(z.string().uuid()).max(50).default([]),
  }),
  permission: 'member.manage',
  handler: async ({ ctx, input }) => {
    const result = await createMemberDirect(ctx, input);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/settings/members`);
    return result;
  },
});

export const removeMemberAction = defineTenantAction({
  schema: z.object({ memberId: z.string().uuid() }),
  permission: 'member.manage',
  handler: async ({ ctx, input }) => {
    await removeMember(ctx, input.memberId);
    revalidatePath(`/${ctx.organizationSlug}/${ctx.branchSlug}/settings/members`);
    return { ok: true };
  },
});
