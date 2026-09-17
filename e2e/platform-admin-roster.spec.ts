import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * The Platform Admin roster — and the regression that made it necessary.
 *
 * /admin/customers rendered the LocalBasic 404 page on a fresh deployment. The
 * route was never broken: `platform_admins` was empty, nothing in the product
 * could fill it, and the gate answers 404 rather than 403 on purpose. So this
 * spec pins BOTH halves — that the Customers page works for an admin and is
 * invisible to everyone else, and that an owner can now put a colleague on the
 * roster without a database console.
 */
const DB = new Pool({
  connectionString:
    process.env.LOCAL_DATABASE_URL ??
    'postgresql://postgres@localhost/localbasic_dev?host=/tmp&port=5433',
});

const OWNER_EMAIL = 'roster-e2e-owner@demo.local';
const STAFF_EMAIL = 'roster-e2e-staff@demo.local';
const OUTSIDER_EMAIL = 'roster-e2e-outsider@demo.local';

let ownerId = '';
let staffId = '';
let outsiderId = '';
let tenantOwnerId = '';

async function makeUser(email: string, name: string): Promise<string> {
  await DB.query(
    `insert into auth.users (email, raw_user_meta_data)
     values ($1, jsonb_build_object('full_name', $2::text))
     on conflict (email) do nothing`,
    [email, name],
  );
  const { rows } = await DB.query('select id from auth.users where email = $1', [email]);
  await DB.query(
    `insert into public.profiles (id, full_name) values ($1, $2)
     on conflict (id) do nothing`,
    [rows[0].id, name],
  );
  return rows[0].id as string;
}

async function actAs(page: Page, id: string) {
  await page.context().addCookies([
    { name: 'lb_local_user', value: id, url: 'http://localhost:3000' },
  ]);
}

test.beforeAll(async () => {
  ownerId = await makeUser(OWNER_EMAIL, 'مالك المنصة');
  staffId = await makeUser(STAFF_EMAIL, 'موظف المنصة');
  outsiderId = await makeUser(OUTSIDER_EMAIL, 'شخص عادي');

  const { rows } = await DB.query("select id from auth.users where email = 'owner@demo.local'");
  tenantOwnerId = rows[0].id as string;

  // The first admin, installed the way a real deployment installs it: out of
  // band, with a privileged connection. That is still the only way in.
  await DB.query(
    `insert into public.platform_admins (user_id, role) values ($1, 'owner')
     on conflict (user_id) do update set role = 'owner', is_active = true`,
    [ownerId],
  );
});

test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) =>
    route.request().url().startsWith('http://localhost:3000') ? route.continue() : route.abort(),
  );
  // Each test starts with only the bootstrap owner on the roster.
  await DB.query('delete from platform_admins where user_id in ($1, $2)', [staffId, outsiderId]);
});

test.afterAll(async () => {
  // The roster rows go; the users stay. Audit rows reference them, and that is
  // the design — a revoked admin must still resolve on the trail — so deleting
  // the identity would mean deleting the history of what they did.
  await DB.query('delete from platform_admins where user_id = any($1)', [
    [ownerId, staffId, outsiderId],
  ]);
  await DB.end();
});

// ---------------------------------------------------------------------------
// The regression: /admin/customers
// ---------------------------------------------------------------------------

test('a platform admin reaches the Customers page', async ({ page }) => {
  await actAs(page, ownerId);
  await page.goto('/admin/customers');

  await expect(page.getByRole('heading', { name: 'العملاء' })).toBeVisible();
  await expect(page.getByPlaceholder(/LB-/)).toBeVisible();
  // And it is the real list, reading real customers.
  await expect(page.getByText('مطعم الحارة الشامية')).toBeVisible();
});

test('the Customers link in the admin nav goes where it says', async ({ page }) => {
  await actAs(page, ownerId);
  await page.goto('/admin');
  await page.getByRole('link', { name: 'العملاء' }).first().click();

  await expect(page).toHaveURL(/\/admin\/customers$/);
  await expect(page.getByRole('heading', { name: 'العملاء' })).toBeVisible();
});

test('everyone who is not a platform admin gets not-found, not a 403', async ({
  page,
  context,
}) => {
  // A tenant's own owner is not a platform operator, and must not learn that
  // the console exists.
  for (const id of [tenantOwnerId, outsiderId]) {
    await context.clearCookies();
    await actAs(page, id);
    await page.goto('/admin/customers');
    await expect(page.getByText('الصفحة غير موجودة')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'العملاء' })).toHaveCount(0);
    // The tab title must not give it away either.
    await expect(page).toHaveTitle(/غير موجودة/);
  }

  await context.clearCookies();
  await page.goto('/admin/customers');
  await expect(page.getByRole('heading', { name: 'العملاء' })).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// The fix: the roster can be managed in the product
// ---------------------------------------------------------------------------

test('an owner adds a colleague, who can then reach the Customers page', async ({
  page,
  context,
}) => {
  // Before: the colleague is refused.
  await actAs(page, staffId);
  await page.goto('/admin/customers');
  await expect(page.getByText('الصفحة غير موجودة')).toBeVisible();

  await context.clearCookies();
  await actAs(page, ownerId);
  await page.goto('/admin/team');
  await expect(page.getByRole('heading', { name: 'فريق المنصة' })).toBeVisible();

  await page.getByLabel('البريد الإلكتروني').fill(STAFF_EMAIL);
  await page.getByLabel('الدور').selectOption('staff');
  await page.getByRole('button', { name: 'منح الصلاحية' }).click();
  await expect(page.getByTestId('roster-saved')).toBeVisible();
  await expect(page.getByTestId('admin-roster')).toContainText(STAFF_EMAIL);

  // After: the same person reaches the page that 404'd a moment ago.
  await context.clearCookies();
  await actAs(page, staffId);
  await page.goto('/admin/customers');
  await expect(page.getByRole('heading', { name: 'العملاء' })).toBeVisible();
});

test('an unknown email is refused, and no account is conjured for it', async ({ page }) => {
  await actAs(page, ownerId);
  await page.goto('/admin/team');

  await page.getByLabel('البريد الإلكتروني').fill('nobody-at-all@demo.local');
  await page.getByRole('button', { name: 'منح الصلاحية' }).click();
  await expect(page.getByTestId('grant-error')).toBeVisible();

  const { rows } = await DB.query('select count(*)::int as n from auth.users where email = $1', [
    'nobody-at-all@demo.local',
  ]);
  expect(rows[0].n).toBe(0);
});

test('staff may read the roster but are offered no way to change it', async ({ page }) => {
  await DB.query(
    `insert into public.platform_admins (user_id, role) values ($1, 'staff')
     on conflict (user_id) do update set role = 'staff', is_active = true`,
    [staffId],
  );

  await actAs(page, staffId);
  await page.goto('/admin/team');

  await expect(page.getByTestId('admin-roster')).toContainText(OWNER_EMAIL);
  // No form, and no revoke buttons.
  await expect(page.getByRole('button', { name: 'منح الصلاحية' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'سحب الصلاحية' })).toHaveCount(0);
  await expect(page.getByText('للاطلاع فقط')).toBeVisible();
});

test('an owner revokes a colleague, who is refused again immediately', async ({
  page,
  context,
}) => {
  await DB.query(
    `insert into public.platform_admins (user_id, role) values ($1, 'staff')
     on conflict (user_id) do update set role = 'staff', is_active = true`,
    [staffId],
  );

  await actAs(page, ownerId);
  await page.goto('/admin/team');
  await page
    .locator('tr', { hasText: STAFF_EMAIL })
    .getByRole('button', { name: 'سحب الصلاحية' })
    .click();
  await expect(page.locator('tr', { hasText: STAFF_EMAIL })).toContainText('موقوف');

  await context.clearCookies();
  await actAs(page, staffId);
  await page.goto('/admin/customers');
  await expect(page.getByText('الصفحة غير موجودة')).toBeVisible();
});

test('the last owner cannot remove themselves', async ({ page }) => {
  await actAs(page, ownerId);
  await page.goto('/admin/team');

  // The screen does not even offer it for your own row — and the database
  // refuses it regardless, which is what suite 20 proves.
  await expect(
    page.locator('tr', { hasText: OWNER_EMAIL }).getByRole('button', { name: 'سحب الصلاحية' }),
  ).toHaveCount(0);
});
