import 'server-only';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AppError, toAppError } from '@/lib/errors';
import { requirePermission, type TenantContext } from '@/modules/core/tenancy/context';

/**
 * Stock transfers between branches.
 *
 * The service does not move anything itself. It hands branches, variants and
 * quantities to retail_stock_transfer(), which writes the document and both
 * movement legs in one transaction — so there is no code path here that can
 * record stock leaving one branch without it arriving at the other.
 *
 * Quantities are validated for shape only. Whether the source branch actually
 * holds them is decided by the database, under the row lock that the POS and
 * the storefront take for the same reason: two people transferring the last
 * units at the same moment must not both succeed.
 */

export const transferInput = z.object({
  /** Where the stock is now. Validated server-side against the tenant. */
  fromBranchId: z.string().uuid(),
  toBranchId: z.string().uuid(),
  lines: z
    .array(
      z.object({
        variantId: z.string().uuid(),
        quantity: z.coerce.number().positive().max(1_000_000),
      }),
    )
    .min(1, 'أضف صنفًا واحدًا على الأقل')
    .max(200),
  note: z.string().trim().max(500).optional(),
});

export type TransferInput = z.infer<typeof transferInput>;

export type TransferRow = {
  id: string;
  fromBranchId: string;
  toBranchId: string;
  note: string | null;
  createdAt: string;
  lineCount: number;
};

/**
 * Move stock.
 *
 * `retail.inventory.transfer` is checked here for a clean refusal and again in
 * the database for both branches — the database check is the boundary, because
 * this permission is the only thing standing between a storekeeper and another
 * branch's inventory.
 */
export async function transferStock(
  ctx: TenantContext,
  input: unknown,
): Promise<{ transferId: string; lineCount: number }> {
  requirePermission(ctx, 'retail.inventory.transfer');

  const parsed = transferInput.safeParse(input);
  if (!parsed.success) {
    throw new AppError('validation', parsed.error.issues[0]?.message ?? 'بيانات غير صالحة');
  }
  if (parsed.data.fromBranchId === parsed.data.toBranchId) {
    throw new AppError('validation', 'المصدر والوجهة لا يمكن أن يكونا نفس الفرع');
  }

  // The same variant twice would be two legs against one stock row and is a
  // mistake rather than two movements; the database refuses it too.
  const ids = parsed.data.lines.map((l) => l.variantId);
  if (new Set(ids).size !== ids.length) {
    throw new AppError('validation', 'الصنف مكرر في نفس التحويل');
  }

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .rpc('retail_stock_transfer', {
      p_org: ctx.organizationId,
      p_from_branch: parsed.data.fromBranchId,
      p_to_branch: parsed.data.toBranchId,
      p_items: parsed.data.lines.map((l) => ({
        variant_id: l.variantId,
        quantity: l.quantity,
      })),
      p_note: parsed.data.note ?? null,
    })
    .single();

  if (error) {
    // 23514 is the non-negative stock CHECK: the source branch does not hold
    // what was asked for, and nothing moved.
    if (error.code === '23514' || error.message.includes('retail_stock_non_negative')) {
      throw new AppError('conflict', 'الكمية المطلوبة غير متوفرة في الفرع المصدر.');
    }
    if (error.code === '42501') {
      throw new AppError('forbidden', 'ليس لديك صلاحية التحويل بين هذين الفرعين.');
    }
    throw toAppError(error, 'transferStock');
  }

  const row = data as unknown as { out_transfer_id: string; out_line_count: number } | null;
  if (!row) throw new AppError('internal');
  return { transferId: row.out_transfer_id, lineCount: row.out_line_count };
}

/**
 * Transfers touching this branch, in or out.
 *
 * RLS already restricts these rows to transfers whose source or destination
 * the caller may read, so the filter here is about relevance, not access.
 */
export async function listTransfers(ctx: TenantContext, limit = 50): Promise<TransferRow[]> {
  requirePermission(ctx, 'retail.inventory.read');

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('retail_stock_transfers')
    .select('id, from_branch_id, to_branch_id, note, created_at')
    .eq('organization_id', ctx.organizationId)
    .or(`from_branch_id.eq.${ctx.branchId},to_branch_id.eq.${ctx.branchId}`)
    .order('created_at', { ascending: false })
    .limit(Math.min(limit, 200));

  if (error) throw toAppError(error, 'listTransfers');
  const rows = data ?? [];
  if (rows.length === 0) return [];

  const { data: lines } = await supabase
    .from('retail_stock_transfer_lines')
    .select('transfer_id')
    .in(
      'transfer_id',
      rows.map((r) => r.id),
    );

  const counts = new Map<string, number>();
  for (const l of lines ?? []) {
    counts.set(l.transfer_id, (counts.get(l.transfer_id) ?? 0) + 1);
  }

  return rows.map((r) => ({
    id: r.id,
    fromBranchId: r.from_branch_id,
    toBranchId: r.to_branch_id,
    note: r.note,
    createdAt: r.created_at,
    lineCount: counts.get(r.id) ?? 0,
  }));
}
