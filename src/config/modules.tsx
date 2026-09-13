import type { Permission } from '@/modules/core/rbac/permissions';

/**
 * The module registry.
 *
 * Core reads navigation and dashboard composition from here, which is the one
 * and only place Core knows a vertical exists. Adding a vertical is a new
 * folder under src/modules, a migration, and an entry in this map — no Core
 * file is edited.
 */
export type NavItem = {
  /** Path relative to /{orgSlug}/{branchSlug} */
  href: string;
  label: string;
  icon: string;
  /** Hidden unless the member holds this permission. Cosmetic only — the
   *  service and RLS still enforce access. */
  permission: Permission;
};

export type ModuleDefinition = {
  key: string;
  nameAr: string;
  nameEn: string;
  navigation: NavItem[];
  publicLinkKinds: string[];
};

export const CORE_NAVIGATION: NavItem[] = [
  { href: '', label: 'لوحة التحكم', icon: 'LayoutDashboard', permission: 'customer.read' },
  { href: '/customers', label: 'العملاء', icon: 'Users', permission: 'customer.read' },
  { href: '/invoices', label: 'الفواتير', icon: 'FileText', permission: 'invoice.read' },
  { href: '/payments', label: 'المدفوعات', icon: 'CreditCard', permission: 'payment.read' },
  { href: '/treasury', label: 'الخزينة', icon: 'Wallet', permission: 'treasury.read' },
  { href: '/reports', label: 'التقارير', icon: 'BarChart3', permission: 'report.read' },
];

export const SETTINGS_NAVIGATION: NavItem[] = [
  { href: '/settings/branches', label: 'الفروع', icon: 'Store', permission: 'branch.manage' },
  { href: '/settings/members', label: 'المستخدمون', icon: 'UserCog', permission: 'member.read' },
  { href: '/settings/roles', label: 'الصلاحيات', icon: 'ShieldCheck', permission: 'role.manage' },
  { href: '/settings/branding', label: 'الهوية', icon: 'Palette', permission: 'branding.manage' },
  { href: '/settings/audit', label: 'سجل النشاط', icon: 'ScrollText', permission: 'audit.read' },
];

export const MODULES: Record<string, ModuleDefinition> = {
  retail: {
    key: 'retail',
    nameAr: 'متجر / تجزئة',
    nameEn: 'Retail',
    navigation: [
      { href: '/pos', label: 'نقطة البيع', icon: 'ScanBarcode', permission: 'retail.pos.use' },
      { href: '/products', label: 'المنتجات', icon: 'Package', permission: 'retail.product.read' },
      { href: '/inventory', label: 'المخزون', icon: 'Boxes', permission: 'retail.inventory.read' },
      { href: '/purchases', label: 'المشتريات', icon: 'Truck', permission: 'retail.purchase.read' },
      { href: '/orders', label: 'طلبات المتجر', icon: 'ShoppingCart', permission: 'retail.order.read' },
    ],
    publicLinkKinds: ['store', 'order_status'],
  },
};

export function getModule(key: string): ModuleDefinition | undefined {
  return MODULES[key];
}
