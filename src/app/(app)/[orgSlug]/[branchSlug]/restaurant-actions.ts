'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { defineTenantAction } from '@/lib/action';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { toAppError } from '@/lib/errors';
import {
  categorySchema,
  menuProductSchema,
  toggleProductSchema,
  toggleBestSellerSchema,
  setAvailabilitySchema,
} from '@/modules/restaurant/menu/schemas';
import {
  createCategory,
  createMenuProduct,
  setProductActive,
  setProductBestSeller,
  setBranchAvailability,
} from '@/modules/restaurant/menu/service';
import {
  sectionSchema,
  tableSchema,
  bulkTablesSchema,
  tableStatusSchema,
  reissueQrSchema,
} from '@/modules/restaurant/tables/schemas';
import {
  createSection,
  createTable,
  createTableRange,
  issueTableQr,
  setTableStatus,
} from '@/modules/restaurant/tables/service';
import {
  createOrderSchema,
  setStatusSchema,
  payOrderSchema,
} from '@/modules/restaurant/orders/schemas';
import { createOrder, setOrderStatus, payOrder } from '@/modules/restaurant/orders/service';

/**
 * Every restaurant mutation. Each declares the permission it needs; the action
 * wrapper resolves the tenant from the URL, checks that permission server-side
 * and parses the input before the handler runs.
 */

function revalidateBranch(orgSlug: string, branchSlug: string, ...paths: string[]) {
  for (const path of paths) revalidatePath(`/${orgSlug}/${branchSlug}${path}`);
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------
export const createMenuCategoryAction = defineTenantAction({
  schema: categorySchema,
  permission: 'restaurant.menu.manage',
  handler: async ({ ctx, input }) => {
    const result = await createCategory(ctx, input);
    revalidateBranch(ctx.organizationSlug, ctx.branchSlug, '/menu');
    return result;
  },
});

export const createMenuProductAction = defineTenantAction({
  schema: menuProductSchema,
  permission: 'restaurant.menu.manage',
  handler: async ({ ctx, input }) => {
    const result = await createMenuProduct(ctx, input);
    revalidateBranch(ctx.organizationSlug, ctx.branchSlug, '/menu', '/cashier');
    return result;
  },
});

export const toggleMenuProductAction = defineTenantAction({
  schema: toggleProductSchema,
  permission: 'restaurant.menu.manage',
  handler: async ({ ctx, input }) => {
    await setProductActive(ctx, input.productId, input.isActive);
    revalidateBranch(ctx.organizationSlug, ctx.branchSlug, '/menu', '/cashier');
    return { ok: true };
  },
});

export const toggleBestSellerAction = defineTenantAction({
  schema: toggleBestSellerSchema,
  permission: 'restaurant.menu.manage',
  handler: async ({ ctx, input }) => {
    await setProductBestSeller(ctx, input.productId, input.isBestSeller);
    revalidateBranch(ctx.organizationSlug, ctx.branchSlug, '/menu');
    return { ok: true };
  },
});

/**
 * Marking a dish off at this branch. The kitchen can do this as well as a
 * manager — they are the ones who know the fridge is empty.
 */
export const setAvailabilityAction = defineTenantAction({
  schema: setAvailabilitySchema,
  permission: 'restaurant.menu.read',
  handler: async ({ ctx, input }) => {
    await setBranchAvailability(ctx, input);
    revalidateBranch(ctx.organizationSlug, ctx.branchSlug, '/menu', '/cashier', '/kitchen');
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// Floor plan
// ---------------------------------------------------------------------------
export const createSectionAction = defineTenantAction({
  schema: sectionSchema,
  permission: 'restaurant.table.manage',
  handler: async ({ ctx, input }) => {
    const result = await createSection(ctx, input);
    revalidateBranch(ctx.organizationSlug, ctx.branchSlug, '/tables');
    return result;
  },
});

export const createTableAction = defineTenantAction({
  schema: tableSchema,
  permission: 'restaurant.table.manage',
  handler: async ({ ctx, input }) => {
    const result = await createTable(ctx, input);
    revalidateBranch(ctx.organizationSlug, ctx.branchSlug, '/tables', '/service');
    return result;
  },
});

export const createTableRangeAction = defineTenantAction({
  schema: bulkTablesSchema,
  permission: 'restaurant.table.manage',
  handler: async ({ ctx, input }) => {
    const result = await createTableRange(ctx, input);
    revalidateBranch(ctx.organizationSlug, ctx.branchSlug, '/tables', '/service');
    return result;
  },
});

export const setTableStatusAction = defineTenantAction({
  schema: tableStatusSchema,
  permission: 'restaurant.table.status',
  handler: async ({ ctx, input }) => {
    await setTableStatus(ctx, input.tableId, input.status);
    revalidateBranch(ctx.organizationSlug, ctx.branchSlug, '/tables', '/service', '/cashier');
    return { ok: true };
  },
});

/** Rotating a QR retires whatever was printed before — that is the point. */
export const reissueTableQrAction = defineTenantAction({
  schema: reissueQrSchema,
  permission: 'restaurant.table.manage',
  handler: async ({ ctx, input }) => {
    const result = await issueTableQr(ctx, input.tableId);
    revalidateBranch(ctx.organizationSlug, ctx.branchSlug, '/tables');
    return result;
  },
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------
export const createOrderAction = defineTenantAction({
  schema: createOrderSchema,
  permission: 'restaurant.order.create',
  handler: async ({ ctx, input }) => {
    // The channel is decided here, not by the client: an order created through
    // a staff screen is never recorded as a guest QR order.
    const channel = ctx.permissions.has('restaurant.pos.use') ? 'cashier' : 'waiter';
    const result = await createOrder(ctx, input, channel);
    revalidateBranch(ctx.organizationSlug, ctx.branchSlug, '/orders', '/cashier', '/kitchen', '/service');
    return result;
  },
});

/**
 * Status changes need only `restaurant.order.read` at this layer: the database
 * function checks the specific permission each transition requires — kitchen
 * for preparing and ready, service for served, till for completed — so a role
 * cannot advance a stage that is not its job.
 */
export const setOrderStatusAction = defineTenantAction({
  schema: setStatusSchema,
  permission: 'restaurant.order.read',
  handler: async ({ ctx, input }) => {
    await setOrderStatus(ctx, input.orderId, input.status, input.reason);
    revalidateBranch(
      ctx.organizationSlug,
      ctx.branchSlug,
      '/orders',
      '/cashier',
      '/kitchen',
      '/service',
      '/tables',
    );
    return { ok: true };
  },
});

export const payOrderAction = defineTenantAction({
  schema: payOrderSchema,
  permission: 'restaurant.pos.use',
  handler: async ({ ctx, input }) => {
    const result = await payOrder(ctx, input);
    revalidateBranch(
      ctx.organizationSlug,
      ctx.branchSlug,
      '/orders',
      '/cashier',
      '/tables',
      '/treasury',
      '/invoices',
    );
    return result;
  },
});

// ---------------------------------------------------------------------------
// Core: expenses recorded against the branch treasury
// ---------------------------------------------------------------------------
const expenseSchema = z.object({
  amountCents: z.coerce.number().int().positive('أدخل مبلغًا صحيحًا'),
  category: z.enum(['supplies', 'maintenance', 'utilities', 'salary', 'rent', 'other']),
  reason: z.string().trim().min(1, 'اذكر سبب المصروف').max(300),
  accountId: z.string().uuid().optional(),
});

export const recordExpenseAction = defineTenantAction({
  schema: expenseSchema,
  permission: 'treasury.create',
  handler: async ({ ctx, input }) => {
    const supabase = createSupabaseServerClient();

    let accountId = input.accountId;
    if (!accountId) {
      const { data: account } = await supabase
        .from('treasury_accounts')
        .select('id')
        .eq('branch_id', ctx.branchId)
        .eq('is_default', true)
        .eq('is_active', true)
        .maybeSingle();
      accountId = account?.id;
    }
    if (!accountId) throw toAppError(new Error('no default treasury account'), 'recordExpense');

    const { error } = await supabase.from('treasury_transactions').insert({
      organization_id: ctx.organizationId,
      branch_id: ctx.branchId,
      account_id: accountId,
      direction: 'out',
      amount_cents: input.amountCents,
      currency: ctx.currency,
      category: input.category,
      reason: input.reason,
      ref_type: 'manual',
      created_by: ctx.userId,
    });
    if (error) throw toAppError(error, 'recordExpense');

    revalidateBranch(ctx.organizationSlug, ctx.branchSlug, '/expenses', '/treasury', '/reports');
    return { ok: true };
  },
});
