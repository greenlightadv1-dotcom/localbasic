import 'server-only';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AppError, toAppError } from '@/lib/errors';
import { requirePermission, type TenantContext } from '@/modules/core/tenancy/context';

/**
 * Adding a branch to an existing organization, past the one made during
 * onboarding.
 *
 * All the real authorization — branch.create, and the plan's branch limit —
 * lives in branch_create() (migration 0079), the same "one narrow
 * SECURITY DEFINER function is the only way in" shape as every other write in
 * this schema. requirePermission() here is for a clean early error rather
 * than a raw Postgres one; it is never the only gate.
 */

export const createBranchInput = z.object({
  name: z.string().trim().min(1, 'اسم الفرع مطلوب').max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(2, 'المعرّف حرفان على الأقل')
    .max(50)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'حروف إنجليزية صغيرة وأرقام وشرطات فقط'),
  address: z.string().trim().max(300).optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
});

export type CreateBranchInput = z.infer<typeof createBranchInput>;

export async function createBranch(
  ctx: TenantContext,
  input: CreateBranchInput,
): Promise<{ branchId: string; slug: string }> {
  requirePermission(ctx, 'branch.create');

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('branch_create', {
    p_org: ctx.organizationId,
    p_name: input.name,
    p_slug: input.slug,
    p_address: input.address || null,
    p_phone: input.phone || null,
  });

  if (error) {
    // 23505 = unique_violation: this organization already has a branch with
    // this slug (branches_organization_id_slug_key, 0001).
    if (error.code === '23505') {
      throw new AppError('validation', 'هذا المعرّف مستخدم لفرع آخر في نفس المنشأة. اختر معرّفًا مختلفًا.');
    }
    // Every other failure — permission, validation, or the plan's branch
    // limit — is raised from branch_create() with a message already meant to
    // be read by the person who submitted the form.
    throw toAppError(error, 'createBranch');
  }
  if (!data) throw new AppError('internal');

  return { branchId: data as string, slug: input.slug };
}

export type BranchLimitInfo = {
  used: number;
  /** null means the current plan (or the absence of one) caps nothing. */
  limit: number | null;
  planName: string | null;
};

/**
 * What the branches settings screen shows above the create form: how many
 * branches this organization already has, against what its plan allows —
 * read directly, not duplicated from branch_create()'s own check, so the two
 * can never drift apart.
 */
export async function getBranchLimitInfo(ctx: TenantContext): Promise<BranchLimitInfo> {
  const supabase = createSupabaseServerClient();

  const [{ count }, { data: planRow }] = await Promise.all([
    supabase
      .from('branches')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', ctx.organizationId)
      .is('deleted_at', null),
    supabase
      .from('subscriptions')
      .select('plans(name_ar, limits)')
      .eq('organization_id', ctx.organizationId)
      .in('status', ['trialing', 'active', 'past_due'])
      .maybeSingle(),
  ]);

  const plan = planRow?.plans as unknown as { name_ar: string; limits: Record<string, unknown> } | null;
  const rawLimit = plan?.limits?.['branches'];
  const limit = typeof rawLimit === 'number' ? rawLimit : null;

  return { used: count ?? 0, limit, planName: plan?.name_ar ?? null };
}
