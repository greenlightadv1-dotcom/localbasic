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
  /** Hidden unless the member holds this permission (or any one of these,
   *  for a screen more than one role may open). Cosmetic only — the
   *  service and RLS still enforce access. */
  permission: Permission | Permission[];
  /**
   * Hidden unless the organization has at least one of these modules
   * enabled. Omit for an item every vertical should see (e.g. it belongs to
   * Core, not to a vertical at all).
   */
  modules?: string[];
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
  // Restaurant payment methods and gateway settings. This entry used to point
  // at a /payments page that never existed (a dead link); it now opens the
  // real screen, so it needs the permission that screen checks.
  {
    href: '/settings/payments', label: 'المدفوعات', icon: 'CreditCard',
    permission: 'settings.manage', modules: ['restaurant'],
  },
  { href: '/treasury', label: 'الخزينة', icon: 'Wallet', permission: 'treasury.read' },
  { href: '/expenses', label: 'المصروفات', icon: 'Receipt', permission: 'treasury.create' },
  { href: '/reports', label: 'التقارير', icon: 'BarChart3', permission: 'report.read' },
];

export const SETTINGS_NAVIGATION: NavItem[] = [
  { href: '/settings/branches', label: 'الفروع', icon: 'Store', permission: 'branch.manage' },
  { href: '/settings/members', label: 'الموظفون', icon: 'UserCog', permission: 'member.read' },
  { href: '/settings/roles', label: 'الصلاحيات', icon: 'ShieldCheck', permission: 'role.manage' },
  // Brand & Theme: identity (name, logo, colors where the plan has them) and
  // the public menu's description, hours and publish switch, on one screen.
  // There is no layout editor any more. Visible to whoever holds either
  // half's permission, so a role with only settings.manage (no
  // branding.manage) still sees the menu content.
  {
    href: '/settings/branding', label: 'الهوية والثيم', icon: 'Palette',
    permission: ['branding.manage', 'settings.manage'],
  },
  // Custom domain management, standalone: a different concern (DNS/TLS
  // verification) from editing the site itself.
  {
    href: '/settings/website/domains', label: 'النطاق', icon: 'Link2',
    permission: ['branding.manage', 'settings.manage'],
    modules: ['restaurant'],
  },
  { href: '/settings/online-ordering', label: 'الطلب أونلاين', icon: 'ShoppingBag', permission: 'settings.manage' },
  { href: '/settings/payments', label: 'المدفوعات', icon: 'CreditCard', permission: 'settings.manage', modules: ['restaurant'] },
  { href: '/settings/loyalty', label: 'المكافآت', icon: 'Gift', permission: 'settings.manage', modules: ['restaurant'] },
  { href: '/settings/receipt', label: 'بيانات الإيصال', icon: 'Receipt', permission: 'settings.manage', modules: ['restaurant'] },
  { href: '/settings/integrations', label: 'تكامل الطلبات', icon: 'Plug', permission: 'restaurant.integration.manage', modules: ['restaurant'] },
  { href: '/settings/approval-pin', label: 'رمز الموافقة', icon: 'KeyRound', permission: 'approval.grant', modules: ['restaurant'] },
  { href: '/settings/cashier-zones', label: 'مناطق الكاشير', icon: 'MapPinned', permission: 'member.manage', modules: ['restaurant'] },
  { href: '/settings/features', label: 'الخدمات التشغيلية', icon: 'ToggleLeft', permission: 'organization.manage' },
  // Retail's online store toggle — a naming collision with "site" in Arabic
  // only ("store" vs "site"), unrelated to the website builder above. Shown
  // only to retail-vertical organizations so a restaurant never sees it.
  { href: '/settings/store', label: 'المتجر الإلكتروني', icon: 'Store', permission: 'settings.manage', modules: ['retail'] },
  { href: '/settings/audit', label: 'سجل النشاط', icon: 'ScrollText', permission: 'audit.read' },
];

export const MODULES: Record<string, ModuleDefinition> = {
  restaurant: {
    key: 'restaurant',
    nameAr: 'مطعم / كافيه',
    nameEn: 'Restaurant',
    navigation: [
      // The hub (0117): floor & POS, KDS and the modifier builder on one
      // screen; each tab shows only to the roles that can use it.
      {
        href: '/restaurant', label: 'المطعم والمطبخ', icon: 'UtensilsCrossed',
        permission: ['restaurant.table.read', 'restaurant.kitchen.use', 'restaurant.bar.use', 'restaurant.menu.manage'],
      },
      { href: '/cashier', label: 'الكاشير', icon: 'ScanBarcode', permission: 'restaurant.pos.use' },
      { href: '/orders', label: 'الطلبات', icon: 'ClipboardList', permission: 'restaurant.order.read' },
      // Chef and barista are separate roles/permissions (0080) with separate
      // screens, each locked server-side to its own station's tickets — a
      // barista never sees food-prep tasks and a chef never sees drink
      // tickets, rather than one shared board with a client-side filter tab.
      { href: '/kitchen', label: 'المطبخ (الشيف)', icon: 'ChefHat', permission: 'restaurant.kitchen.use' },
      { href: '/barista', label: 'الباريستا', icon: 'Coffee', permission: 'restaurant.bar.use' },
      { href: '/kitchen/analytics', label: 'أداء المطبخ', icon: 'Timer', permission: 'restaurant.kitchen.analytics' },
      { href: '/service', label: 'الصالة', icon: 'ConciergeBell', permission: 'restaurant.service.use' },
      // Live floor plan: colour-coded tables, transfer / merge / split, waiting list (0105).
      { href: '/floor', label: 'مخطط الصالة', icon: 'Map', permission: 'restaurant.table.read' },
      { href: '/tables', label: 'الطاولات', icon: 'LayoutGrid', permission: 'restaurant.table.read' },
      // Delivery & fleet, call center, CRM (0106/0107).
      { href: '/call-center', label: 'الكول سنتر', icon: 'PhoneCall', permission: 'restaurant.callcenter.use' },
      {
        href: '/delivery', label: 'التوصيل والمناديب', icon: 'Bike',
        permission: ['restaurant.delivery.manage', 'restaurant.driver.manage', 'restaurant.driver.settle'],
      },
      { href: '/my-deliveries', label: 'رحلاتي', icon: 'Navigation', permission: 'restaurant.driver.use' },
      { href: '/promotions', label: 'العروض والولاء', icon: 'BadgePercent', permission: ['restaurant.promotion.manage', 'restaurant.loyalty.manage'] },
      { href: '/accounts', label: 'الحسابات الآجلة', icon: 'Building2', permission: 'restaurant.account.manage' },
      // Fraud prevention: risk scores per cashier, flagged staff, resets (0108).
      { href: '/audit/cashier-risk', label: 'مخاطر الكاشير', icon: 'ShieldAlert', permission: 'restaurant.audit.risk_view' },
      { href: '/menu', label: 'المنيو', icon: 'BookOpen', permission: 'restaurant.menu.read' },
      // Raw materials: warehouse, recipes, issues to the kitchen/bar (0102).
      { href: '/stock', label: 'المخزن والخامات', icon: 'Warehouse', permission: 'inventory.read' },
      // Costing, wastage, purchasing and menu engineering (0109), over the 0102 stock.
      { href: '/inventory/recipes', label: 'الوصفات والتكلفة', icon: 'ChefHat', permission: 'inventory.read' },
      { href: '/inventory/wastage', label: 'الهالك', icon: 'Trash2', permission: ['inventory.read', 'inventory.waste'] },
      { href: '/inventory/purchasing', label: 'المشتريات والتنبيهات', icon: 'ShoppingCart', permission: ['inventory.read', 'inventory.purchase'] },
      // Executive command center: profit, basket, speed of service, RFM, campaigns (0110).
      { href: '/analytics/executive-dashboard', label: 'مركز القيادة', icon: 'LayoutDashboard', permission: 'restaurant.analytics.executive' },
      { href: '/analytics/menu-matrix', label: 'هندسة المنيو', icon: 'ScatterChart', permission: 'report.read' },
      // Writes the catalog, so it lives under the menu rather than under the
      // Site Engine: a site's menu section reads these same tables live.
      { href: '/menu/import', label: 'استيراد الأصناف', icon: 'Upload', permission: 'restaurant.menu.manage' },
      // Display-only merchandising cards for the customer-facing site's
      // "bundles" section; the same reason /menu/import lives under menu
      // rather than the Site Engine.
      { href: '/menu/bundles', label: 'العروض والباقات', icon: 'Gift', permission: 'restaurant.menu.manage' },
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
      { href: '/retail-pos', label: 'كاشير التجزئة', icon: 'ScanBarcode', permission: 'retail.pos.use' },
      { href: '/products', label: 'المنتجات', icon: 'Package', permission: 'retail.product.read' },
      { href: '/inventory', label: 'المخزون', icon: 'Boxes', permission: 'retail.inventory.read' },
      { href: '/retail-inventory', label: 'التحويلات وإعادة الطلب', icon: 'Truck', permission: 'retail.inventory.read' },
      { href: '/purchases', label: 'المشتريات', icon: 'Truck', permission: 'retail.purchase.read' },
      { href: '/suppliers', label: 'الموردون', icon: 'Factory', permission: 'retail.purchase.read' },
      { href: '/store-orders', label: 'طلبات المتجر', icon: 'ShoppingCart', permission: 'retail.order.read' },
    ],
    publicLinkKinds: ['store', 'order_status'],
  },
  // The clinic vertical. Its key stays 'medical' (organization_modules,
  // permissions); "clinic" is the product word and the route prefix.
  medical: {
    key: 'medical',
    nameAr: 'عيادة',
    nameEn: 'Clinic',
    navigation: [
      { href: '/clinic-appointments', label: 'المواعيد', icon: 'CalendarDays', permission: ['clinic.appointment.read', 'clinic.emr.write'] },
      { href: '/clinic-emr', label: 'الملف الطبي', icon: 'FileHeart', permission: 'clinic.emr.read' },
    ],
    publicLinkKinds: [],
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
