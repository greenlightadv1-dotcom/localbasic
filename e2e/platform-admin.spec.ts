import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * The Platform Admin boundary, driven through the real screens.
 *
 * The SQL suite proves the database refuses a tenant user. This proves the
 * same thing at the surface a person actually reaches — and that a genuine
 * admin can complete the customer workflow end to end.
 */
const DB = new Pool({
  connectionString:
    process.env.LOCAL_DATABASE_URL ??
    'postgresql://postgres@localhost/localbasic_dev?host=/tmp&port=5433',
});

async function userId(email: string) {
  const { rows } = await DB.query('select id from auth.users where email = $1', [email]);
  return rows[0].id as string;
}

/** The demo platform admin, created on demand so the spec seeds itself. */
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

async function customerCode() {
  const { rows } = await DB.query(
    "select customer_code from organizations where slug = 'alhara'",
  );
  return rows[0].customer_code as string;
}

// This sandbox has no egress; a stalled webfont request would hold every
// navigation open until the test times out.
test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) =>
    route.request().url().startsWith('http://localhost:3000') ? route.continue() : route.abort(),
  );
});

test.afterAll(async () => { await DB.end(); });

test('a tenant owner cannot reach any platform admin screen', async ({ page }) => {
  await actAs(page, await userId('owner@demo.local'));
  const code = await customerCode();

  for (const path of [
    '/admin',
    '/admin/organizations',
    '/admin/subscriptions',
    '/admin/plans',
    '/admin/promo-codes',
    '/admin/audit',
    `/admin/organizations/${code}`,
  ]) {
    await page.goto(path);
    // Not a permission error — the same "does not exist" the rest of the
    // platform gives for a resource you may not see.
    await expect(page.getByText('الصفحة غير موجودة')).toBeVisible();
    // And nothing about any customer leaks onto the page.
    await expect(page.locator('body')).not.toContainText(code);
    await expect(page.locator('body')).not.toContainText('مطعم الحارة الشامية');
  }
});

test('an anonymous visitor cannot reach the platform admin', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/admin/organizations');
  await expect(page.getByText('الصفحة غير موجودة')).toBeVisible();
});

test('a platform admin searches by customer code and renews for cash', async ({ page }) => {
  await actAs(page, await platformAdminId());
  const code = await customerCode();

  // Search by the permanent customer code.
  await page.goto('/admin/organizations');
  await page.getByPlaceholder('LB-000125').fill(code);
  await page.getByRole('button', { name: 'بحث' }).click();
  await expect(page.getByText('مطعم الحارة الشامية')).toBeVisible();

  // Open the customer profile.
  await page.getByRole('link', { name: 'مطعم الحارة الشامية' }).click();
  await expect(page.getByText(code)).toBeVisible();
  await expect(page.getByText('تجديد الاشتراك')).toBeVisible();

  const historyBefore = await DB.query(
    `select count(*)::int as n from subscription_events e
      join organizations o on o.id = e.organization_id where o.slug = 'alhara'`,
  );

  // Renew a full year on a PAID plan for cash. No price is typed anywhere —
  // the server multiplies the plan's monthly price by the term. (The demo org
  // starts on the free trial plan, which would correctly price a year at zero.)
  const { rows: basic } = await DB.query("select id from plans where key = 'basic'");
  await page.getByLabel('الباقة').selectOption(basic[0].id as string);
  await page.getByLabel('المدة').selectOption('year');
  await page.getByRole('button', { name: /تسجيل التجديد/ }).click();
  await expect(page.getByText('تم تسجيل التجديد والدفع النقدي.')).toBeVisible();

  // The history grew, and records what was actually charged.
  const { rows } = await DB.query(
    `select e.gross_cents, e.net_cents, e.billing_period, e.payment_method, e.event_type
       from subscription_events e
       join organizations o on o.id = e.organization_id
      where o.slug = 'alhara' order by e.created_at desc limit 1`,
  );
  expect(Number(historyBefore.rows[0].n)).toBeLessThan(
    Number((await DB.query(
      `select count(*)::int as n from subscription_events e
        join organizations o on o.id = e.organization_id where o.slug = 'alhara'`,
    )).rows[0].n),
  );
  const { rows: plan } = await DB.query("select price_cents from plans where key = 'basic'");
  expect(rows[0].billing_period).toBe('year');
  expect(rows[0].payment_method).toBe('cash');
  // Twelve times the monthly price, computed in the database.
  expect(Number(rows[0].gross_cents)).toBe(Number(plan[0].price_cents) * 12);
  expect(Number(rows[0].net_cents)).toBe(Number(plan[0].price_cents) * 12);
});

test('a rejected promo code blocks the renewal and says why', async ({ page }) => {
  await actAs(page, await platformAdminId());
  const code = await customerCode();

  await page.goto(`/admin/organizations/${code}`);
  await page.getByPlaceholder('DEMO30').fill('NOSUCHCODE');
  await page.getByRole('button', { name: /تسجيل التجديد/ }).click();

  // Refused outright rather than quietly charged at full price.
  await expect(page.getByText('الرمز غير موجود.')).toBeVisible();
});
