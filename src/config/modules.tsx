import type { Permission } from '@/modules/core/rbac/permissions';

/**
 * The module registry.
 *
 * Core reads navigation and labels from here, which is the only place Core
 * knows a vertical exists. Adding a vertical is a new folder under
 * src/modules, a migration, and an entry in this map.
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
  /**
   * Vertical-specific wording for a shared Core screen. A restaurant calls the
   * customer's document a receipt; a shop calls it an invoice. Same table, same
   * service, different word on the button.
   */
  coreLabels?: Partial<Record<string, string>>;
  publicLinkKinds: string[];
};

export const CORE_NAVIGATION: NavItem[] = [
  { href: '', label: 'لوحة التحكم', icon: 'LayoutDashboard', permission: 'customer.read' },
  { href: '/customers', label: 'العملاء', icon: 'Users', permission: 'customer.read' },
  { href: '/invoices', label: 'الفواتير', icon: 'FileText', permission: 'invoice.read' },
  { href: '/payments', label: 'المدفوعات', icon: 'CreditCard', permission: 'payment.read' },
  { href: '/treasury', label: 'الخزينة', icon: 'Wallet', permission: 'treasury.read' },
  { href: '/expenses', label: 'المصروفات', icon: 'Receipt', permission: 'treasury.create' },
  { href: '/reports', label: 'التقارير', icon: 'BarChart3', permission: 'report.read' },
];

export const SETTINGS_NAVIGATION: NavItem[] = [
  { href: '/settings/branches', label: 'الفروع', icon: 'Store', permission: 'branch.manage' },
  { href: '/settings/members', label: 'الموظفون', icon: 'UserCog', permission: 'member.read' },
  { href: '/settings/roles', label: 'الصلاحيات', icon: 'ShieldCheck', permission: 'role.manage' },
  { href: '/settings/branding', label: 'الهوية', icon: 'Palette', permission: 'branding.manage' },
  { href: '/settings/online-ordering', label: 'الطلب أونلاين', icon: 'ShoppingBag', permission: 'settings.manage' },
  { href: '/settings/store', label: 'المتجر الإلكتروني', icon: 'Store', permission: 'settings.manage' },
  { href: '/settings/website', label: 'الموقع الإلكتروني', icon: 'Globe', permission: 'settings.manage' },
  // The Site Engine. Distinct from /settings/website above, which is the
  // restaurant's single live-data site; this one is many sites per
  // organization with their own pages. Gated on site.read, so it stays hidden
  // from anyone the feature has not been granted to.
  { href: '/settings/sites', label: 'المواقع', icon: 'LayoutTemplate', permission: 'site.read' },
  { href: '/settings/audit', label: 'سجل النشاط', icon: 'ScrollText', permission: 'audit.read' },
];

export const MODULES: Record<string, ModuleDefinition> = {
  restaurant: {
    key: 'restaurant',
    nameAr: 'مطعم / كافيه',
    nameEn: 'Restaurant',
    navigation: [
      { href: '/cashier', label: 'الكاشير', icon: 'ScanBarcode', permission: 'restaurant.pos.use' },
      { href: '/orders', label: 'الطلبات', icon: 'ClipboardList', permission: 'restaurant.order.read' },
      { href: '/kitchen', label: 'المطبخ', icon: 'ChefHat', permission: 'restaurant.kitchen.use' },
      { href: '/service', label: 'الصالة', icon: 'ConciergeBell', permission: 'restaurant.service.use' },
      { href: '/tables', label: 'الطاولات', icon: 'LayoutGrid', permission: 'restaurant.table.read' },
      { href: '/menu', label: 'المنيو', icon: 'BookOpen', permission: 'restaurant.menu.read' },
    ],
    // A restaurant issues receipts to guests, not invoices.
    coreLabels: { '/invoices': 'الإيصالات' },
    publicLinkKinds: ['menu', 'order_status'],
  },
  retail: {
    key: 'retail',
    nameAr: 'متجر / تجزئة',
    nameEn: 'Retail',
    navigation: [
      { href: '/pos', label: 'نقطة البيع', icon: 'ScanBarcode', permission: 'retail.pos.use' },
      { href: '/products', label: 'المنتجات', icon: 'Package', permission: 'retail.product.read' },
      { href: '/inventory', label: 'المخزون', icon: 'Boxes', permission: 'retail.inventory.read' },
      { href: '/purchases', label: 'المشتريات', icon: 'Truck', permission: 'retail.purchase.read' },
      { href: '/suppliers', label: 'الموردون', icon: 'Factory', permission: 'retail.purchase.read' },
      { href: '/store-orders', label: 'طلبات المتجر', icon: 'ShoppingCart', permission: 'retail.order.read' },
    ],
    publicLinkKinds: ['store', 'order_status'],
  },
};

export function getModule(key: string): ModuleDefinition | undefined {
  return MODULES[key];
}

/** Core navigation with any vertical-specific wording applied. */
export function coreNavigationFor(moduleKeys: string[]): NavItem[] {
  const overrides = moduleKeys
    .map((key) => MODULES[key]?.coreLabels)
    .filter(Boolean) as Partial<Record<string, string>>[];

  return CORE_NAVIGATION.map((item) => {
    const label = overrides.find((o) => o[item.href])?.[item.href];
    return label ? { ...item, label } : item;
  });
}
