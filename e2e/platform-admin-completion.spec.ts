import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * Stage C.5 surfaces: leads, services, promo management and onboarding.
 *
 * The SQL suite proves the database refuses non-admins. This proves the screens
 * behave, and that an unauthorized visitor learns nothing — not even from the
 * page title.
 */
const DB = new Pool({
  connectionString:
    process.env.LOCAL_DATABASE_URL ??
    'postgresql://postgres@localhost/localbasic_dev?host=/tmp&port=5433',
});

async function userId(email: string) {
  const { rows } = await DB.query('select id from auth.users where email = $1', [email]);
  return rows[0]?.id as string;
}

async function platformAdminId() {
  await DB.query(`
    insert into auth.users (email, raw_user_meta_data)
    values ('platform@demo.local', '{"full_name":"مشرف المنصة"}'::jsonb)
    on conflict (email) do nothing`);
  await DB.query(`
    insert into public.profiles (id, full_name)
    select id, 'مشرف المنصة' from auth.users where email = 'platform@demo.local'
    on conflict (id) do nothing`);
  await DB.query(`
    insert into public.platform_admins (user_id, role)
    select id, 'owner' from auth.users where email = 'platform@demo.local'
    on conflict (user_id) do nothing`);
  return userId('platform@demo.local');
}

async function actAs(page: Page, id: string) {
  await page.context().addCookies([
    { name: 'lb_local_user', value: id, url: 'http://localhost:3000' },
  ]);
}

const ADMIN_ROUTES = [
  '/admin/leads',
  '/admin/services',
  '/admin/promo-codes',
  '/admin/onboard',
];

test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) =>
    route.request().url().startsWith('http://localhost:3000') ? route.continue() : route.abort(),
  );
});

test.afterAll(async () => { await DB.end(); });

test('tenant owner and manager are refused every new admin screen', async ({ page }) => {
  for (const email of ['owner@demo.local', 'manager@demo.local']) {
    await page.context().clearCookies();
    await actAs(page, await userId(email));
    for (const path of ADMIN_ROUTES) {
      await page.goto(path);
      await expect(page.getByText('الصفحة غير موجودة')).toBeVisible();
      // The title must not reveal the surface exists either.
      await expect(page).toHaveTitle(/الصفحة غير موجودة/);
    }
  }
});

test('an anonymous visitor is refused, title included', async ({ page }) => {
  await page.context().clearCookies();
  for (const path of ADMIN_ROUTES) {
    await page.goto(path);
    await expect(page.getByText('الصفحة غير موجودة')).toBeVisible();
    await expect(page).toHaveTitle(/الصفحة غير موجودة/);
  }
});

test('a platform admin works a lead through the pipeline', async ({ page }) => {
  await actAs(page, await platformAdminId());
  const phone = `0100${Date.now().toString().slice(-7)}`;

  await page.goto('/admin/leads');
  await page.getByLabel('الاسم').fill('عميل اختبار');
  await page.getByLabel('الهاتف / واتساب').fill(phone);
  await page.getByLabel('اسم النشاط').fill('مطعم الاختبار');
  await page.getByRole('button', { name: 'إضافة عميل محتمل' }).click();

  await expect(page.getByText('تمت الإضافة.')).toBeVisible();
  await expect(page.getByText('عميل اختبار').first()).toBeVisible();

  const { rows } = await DB.query(
    'select id, status from platform_leads where phone = $1', [phone],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe('new');

  // Move it along, and confirm the database agrees.
  const row = page.locator('li', { hasText: phone }).first();
  await row.getByLabel('الحالة').selectOption('qualified');
  await row.getByRole('button', { name: 'حفظ' }).click();
  await expect(row.getByText('تم التحديث.')).toBeVisible();

  const after = await DB.query('select status from platform_leads where phone = $1', [phone]);
  expect(after.rows[0].status).toBe('qualified');
});

test('a platform admin creates a promo code, normalised and server-priced', async ({ page }) => {
  await actAs(page, await platformAdminId());
  const code = `E2E${Date.now().toString().slice(-6)}`;

  await page.goto('/admin/promo-codes');
  // Typed lowercase on purpose — the server upper-cases it.
  await page.getByLabel('الرمز').fill(code.toLowerCase());
  await page.getByLabel('النوع').selectOption('percent');
  await page.getByLabel('نسبة الخصم %').fill('25');
  await page.getByRole('button', { name: 'إنشاء الرمز' }).click();
  await expect(page.getByText('تم إنشاء الرمز.')).toBeVisible();
  await expect(page).toHaveURL(/created=1/);

  const { rows } = await DB.query(
    'select code, kind, percent_off, is_active from promo_codes where code = $1', [code],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].code).toBe(code);          // normalised to upper case
  expect(rows[0].percent_off).toBe(25);
  expect(rows[0].is_active).toBe(true);

  // Deactivating keeps the row — there is no delete.
  const row = page.locator('tr', { hasText: code }).first();
  await row.getByRole('button', { name: 'إيقاف' }).click();
  await expect(page.locator('tr', { hasText: code }).first().getByText('موقوف')).toBeVisible();

  const after = await DB.query('select is_active from promo_codes where code = $1', [code]);
  expect(after.rows).toHaveLength(1);
  expect(after.rows[0].is_active).toBe(false);
});

test('a duplicate promo code is refused', async ({ page }) => {
  await actAs(page, await platformAdminId());
  const code = `DUP${Date.now().toString().slice(-6)}`;
  await DB.query(
    "insert into promo_codes (code, kind, percent_off) values ($1, 'percent', 10)", [code],
  );

  await page.goto('/admin/promo-codes');
  await page.getByLabel('الرمز').fill(code);
  await page.getByLabel('النوع').selectOption('percent');
  await page.getByLabel('نسبة الخصم %').fill('50');
  await page.getByRole('button', { name: 'إنشاء الرمز' }).click();

  await expect(page.getByText('هذا الرمز موجود بالفعل.')).toBeVisible();
  const { rows } = await DB.query('select percent_off from promo_codes where code = $1', [code]);
  expect(rows).toHaveLength(1);
  expect(rows[0].percent_off).toBe(10);  // unchanged
});

test('service availability gates new provisioning without touching customers', async ({ page }) => {
  await actAs(page, await platformAdminId());

  await page.goto('/admin/services');
  await expect(page.getByText('مطاعم وكافيهات')).toBeVisible();
  // An unbuilt service cannot be put on sale at all.
  await expect(page.getByText('غير مبنية').first()).toBeVisible();

  const card = page.locator('div').filter({ hasText: /^مطاعم وكافيهات/ }).first();
  await card.getByRole('button', { name: 'إيقاف البيع' }).click();
  await expect(page.getByText('موقوف عن البيع')).toBeVisible();

  // The existing customer is untouched.
  const { rows } = await DB.query(`
    select count(*)::int as n from organization_modules m
    join organizations o on o.id = m.organization_id
    where o.slug = 'alhara' and m.module_key = 'restaurant' and m.enabled`);
  expect(rows[0].n).toBe(1);

  // Onboarding now refuses to offer it.
  await page.goto('/admin/onboard');
  await expect(page.getByText('لا توجد خدمة متاحة للبيع')).toBeVisible();

  // Put it back.
  await page.goto('/admin/services');
  await page.getByRole('button', { name: 'إتاحة للبيع' }).first().click();
  await expect(page.getByText('متاح للبيع')).toBeVisible();
});

test('onboarding reports missing server configuration instead of faking it', async ({ page }) => {
  await actAs(page, await platformAdminId());
  await page.goto('/admin/onboard');

  // This environment has no service-role key, so the screen must say so — and
  // still offer provisioning for an owner who already has an account.
  await expect(page.getByText('إنشاء حسابات المالكين غير مُهيأ')).toBeVisible();
  await expect(page.getByText('SUPABASE_SERVICE_ROLE_KEY')).toBeVisible();
  await expect(page.getByRole('button', { name: 'إنشاء مساحة العمل' })).toBeVisible();
});

test('onboarding provisions a workspace for an existing owner, atomically', async ({ page }) => {
  await actAs(page, await platformAdminId());

  // An owner who already has an account, so no service-role key is needed.
  const email = `e2eowner${Date.now().toString().slice(-7)}@demo.local`;
  await DB.query('insert into auth.users (email) values ($1)', [email]);
  const ownerId = await userId(email);
  await DB.query(
    'insert into public.profiles (id, full_name) values ($1, $2) on conflict (id) do nothing',
    [ownerId, 'مالك اختبار'],
  );

  const slug = `e2e${Date.now().toString().slice(-7)}`;
  await page.goto('/admin/onboard');
  await page.getByLabel('بريد المالك').fill(email);
  await page.getByLabel('اسم المالك').fill('مالك اختبار');
  await page.getByLabel('اسم المنشأة').fill('مطعم الاختبار الآلي');
  await page.getByLabel('المعرّف (في الرابط)').fill(slug);
  const { rows: plan } = await DB.query("select id from plans where key = 'basic'");
  await page.getByLabel('الباقة').selectOption(plan[0].id as string);
  await page.getByLabel('المدة').selectOption('quarter');
  await page.getByRole('button', { name: 'إنشاء مساحة العمل' }).click();

  // Lands on the new customer's profile with the code confirmed.
  await expect(page).toHaveURL(/\/admin\/customers\/LB-\d{6}\?created=1/);
  await expect(page.getByText(/كود العميل: LB-\d{6}/)).toBeVisible();

  // Workspace, owner, plan, term and history all landed together.
  const { rows } = await DB.query(`
    select o.customer_code, o.owner_user_id, s.billing_period, s.status,
           (select count(*)::int from subscription_events e where e.organization_id = o.id) as events
      from organizations o join subscriptions s on s.organization_id = o.id
     where o.slug = $1`, [slug]);
  expect(rows).toHaveLength(1);
  expect(rows[0].customer_code).toMatch(/^LB-\d{6}$/);
  expect(rows[0].owner_user_id).toBe(ownerId);
  expect(rows[0].billing_period).toBe('quarter');
  expect(rows[0].status).toBe('active');
  expect(rows[0].events).toBeGreaterThanOrEqual(2);
});

test('a duplicate slug leaves no orphan workspace', async ({ page }) => {
  await actAs(page, await platformAdminId());

  const before = await DB.query('select count(*)::int as n from organizations');

  await page.goto('/admin/onboard');
  await page.getByLabel('بريد المالك').fill('owner@demo.local');
  await page.getByLabel('اسم المالك').fill('مالك');
  await page.getByLabel('اسم المنشأة').fill('مكرر');
  await page.getByLabel('المعرّف (في الرابط)').fill('alhara');  // already taken
  const { rows: plan } = await DB.query("select id from plans where key = 'basic'");
  await page.getByLabel('الباقة').selectOption(plan[0].id as string);
  await page.getByRole('button', { name: 'إنشاء مساحة العمل' }).click();

  await expect(page.getByText('هذا المعرّف مستخدم بالفعل.')).toBeVisible();

  const after = await DB.query('select count(*)::int as n from organizations');
  expect(after.rows[0].n).toBe(before.rows[0].n);
});
