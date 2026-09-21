/**
 * Permission keys, mirrored from the seeded `permissions` table.
 *
 * Keeping them as a const array gives compile-time safety at every call site:
 * a typo in `requirePermission(ctx, 'invoice.viod')` is a build error, not a
 * silent authorization hole.
 */
export const PERMISSIONS = [
  'organization.manage',
  'billing.manage',
  'branch.create',
  'branch.manage',
  'settings.manage',
  'branding.manage',
  'audit.read',
  'member.read',
  'member.manage',
  'role.manage',
  'customer.read',
  'customer.create',
  'customer.update',
  'invoice.read',
  'invoice.create',
  'invoice.update',
  'invoice.void',
  'payment.read',
  'payment.create',
  'payment.refund',
  'treasury.read',
  'treasury.create',
  'treasury.manage',
  'report.read',
  // Organization websites (Site Engine). Owner and admin only for now: a
  // branch manager runs a branch, and the company website is not
  // branch-scoped.
  'site.read',
  'site.manage',
  'notification.read',
  'publiclink.read',
  'publiclink.manage',
  'retail.product.read',
  'retail.product.manage',
  'retail.inventory.read',
  'retail.inventory.adjust',
  'retail.inventory.transfer',
  'retail.supplier.manage',
  'retail.purchase.read',
  'retail.purchase.manage',
  'retail.pos.use',
  'retail.pos.discount',
  'retail.order.read',
  'retail.order.manage',
  'retail.store.manage',
  'restaurant.menu.read',
  'restaurant.menu.manage',
  'restaurant.table.read',
  'restaurant.table.manage',
  'restaurant.table.status',
  'restaurant.order.read',
  'restaurant.order.create',
  'restaurant.order.update',
  'restaurant.order.cancel',
  'restaurant.kitchen.use',
  'restaurant.service.use',
  'restaurant.pos.use',
  'restaurant.pos.discount',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Permissions that can hand out other permissions.
 *
 * The rule they exist to express — a member may only grant a permission they
 * themselves hold — is enforced in the DATABASE, by the policies and the
 * app.role_grantable() helper in migration 0053, not here. It has to be: these
 * writes reach role_permissions and user_roles through RLS, and a check in
 * TypeScript would be advice rather than a boundary.
 *
 * This list is kept for the UI, which uses it to mark a permission as one that
 * confers authority over others. It is not a guard, and nothing should treat
 * it as one.
 */
export const ELEVATED_PERMISSIONS: readonly Permission[] = [
  'member.manage',
  'role.manage',
  'billing.manage',
];

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}
