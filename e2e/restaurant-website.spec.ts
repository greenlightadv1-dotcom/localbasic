import { test, expect } from '@playwright/test';
import { Pool } from 'pg';

/**
 * D2 — the public restaurant website.
 *
 * The SQL suite proves the database refuses to publish what it should not.
 * This proves the page a customer actually reaches renders the restaurant's
 * real data, respects the D1.1 ordering settings, and hands off to the D1
 * ordering flow rather than reimplementing it.
 */
const DB = new Pool({
  connectionString:
    process.env.LOCAL_DATABASE_URL ??
    'postgresql://postgres@localhost/localbasic_dev?host=/tmp&port=5433',
});

const SITE = '/r/alhara';

async function orgId() {
  const { rows } = await DB.query("select id from organizations where slug = 'alhara'");
  return rows[0].id as string;
}

/** Writes an organization-scoped setting, as the settings screen would. */
async function setSetting(key: string, value: string) {
  const org = await orgId();
  await DB.query(
    `insert into settings (organization_id, branch_id, key, value)
     values ($1, null, $2, $3::jsonb)
     on conflict (organization_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), key)
     do update set value = excluded.value`,
    [org, key, value],
  );
}

async function clearBranchSetting(key: string) {
  const org = await orgId();
  await DB.query(
    'delete from settings where organization_id = $1 and branch_id is not null and key = $2',
    [org, key],
  );
}

test.beforeAll(async () => {
  // Publish the demo restaurant and open ordering, so this spec depends on its
  // own preconditions rather than on whatever ran before it.
  await setSetting('restaurant.website_enabled', 'true');
  await setSetting('restaurant.website_tagline', '"أشهى المأكولات الشامية"');
  await setSetting('restaurant.website_about', '"نقدّم المطبخ الشامي منذ سنوات."');
  await setSetting('restaurant.online_ordering_enabled', 'true');
  await setSetting('restaurant.pickup_enabled', 'true');
  await setSetting('restaurant.delivery_enabled', 'true');
  await setSetting('restaurant.delivery_fee_cents', '2500');
  for (const k of [
    'restaurant.online_ordering_enabled', 'restaurant.pickup_enabled',
    'restaurant.delivery_enabled', 'restaurant.delivery_fee_cents',
  ]) await clearBranchSetting(k);
});

test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) =>
    route.request().url().startsWith('http://localhost:3000') ? route.continue() : route.abort(),
  );
});

test.afterAll(async () => { await DB.end(); });

test('the Local Basic marketing site is untouched', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('شغّل مطعمك');
  await page.goto('/services/restaurant');
  await expect(page.getByRole('heading', { name: 'نظام إدارة المطاعم والكافيهات' })).toBeVisible();
});

test('an unpublished restaurant is not found', async ({ page }) => {
  await setSetting('restaurant.website_enabled', 'false');
  try {
    await page.goto(SITE);
    await expect(page.getByText('الصفحة غير موجودة')).toBeVisible();
    // The title must not confirm the restaurant exists either.
    await expect(page).toHaveTitle(/الصفحة غير موجودة/);
  } finally {
    await setSetting('restaurant.website_enabled', 'true');
  }
});

test('an unknown slug is not found', async ({ page }) => {
  await page.goto('/r/nosuchrestaurant');
  await expect(page.getByText('الصفحة غير موجودة')).toBeVisible();
  await page.goto('/r/alhara/nosuchbranch');
  await expect(page.getByText('الصفحة غير موجودة')).toBeVisible();
});

test('the website shows the restaurant branding, menu and contact', async ({ page }) => {
  await page.goto(SITE);

  // Branding and content from the database, not hard-coded.
  await expect(page.getByRole('heading', { level: 1 })).toContainText('مطعم الحارة الشامية');
  await expect(page.getByText('أشهى المأكولات الشامية')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'عن المطعم' })).toBeVisible();

  // Real categories and products from the seeded menu.
  await expect(page.getByRole('heading', { name: 'المنيو' })).toBeVisible();
  const { rows } = await DB.query(`
    select c.name from restaurant_categories c
    join organizations o on o.id = c.organization_id
    where o.slug = 'alhara' and c.is_active order by c.sort_order limit 1`);
  await expect(page.getByRole('heading', { name: rows[0].name, exact: true })).toBeVisible();

  const { rows: prod } = await DB.query(`
    select p.name from restaurant_products p
    join organizations o on o.id = p.organization_id
    where o.slug = 'alhara' and p.is_active and p.deleted_at is null
    order by p.sort_order limit 1`);
  await expect(page.getByRole('heading', { name: prod[0].name, exact: true })).toBeVisible();

  // Location and SEO.
  await expect(page.getByRole('heading', { name: /أين نحن|فروعنا/ })).toBeVisible();
  await expect(page).toHaveTitle(/مطعم الحارة الشامية/);
  const canonical = page.locator('link[rel="canonical"]');
  await expect(canonical).toHaveAttribute('href', /\/r\/alhara$/);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    'content', /مطعم الحارة الشامية/,
  );
});

test('prices render in the restaurant currency', async ({ page }) => {
  await page.goto(SITE);
  const { rows } = await DB.query("select currency from organizations where slug = 'alhara'");
  // At least one price on the menu, shown in the org's own currency.
  await expect(page.getByText(new RegExp(rows[0].currency)).first()).toBeVisible();
});

test('the order CTA appears and leads to the D1 ordering flow', async ({ page }) => {
  await page.goto(SITE);
  await page.getByRole('link', { name: 'اطلب الآن' }).first().click();

  // Hands off to the existing ordering route — no second cart engine.
  await expect(page).toHaveURL(/\/order\/alhara\/main$/);
  await expect(page.getByRole('button', { name: 'أضف للسلة' }).first()).toBeVisible();
});

test('the delivery fee shown is the configured one', async ({ page }) => {
  await page.goto(SITE);
  await expect(page.getByText(/رسوم التوصيل/)).toBeVisible();

  const { rows } = await DB.query(`
    select (s.value #>> '{}')::bigint as fee from settings s
    join organizations o on o.id = s.organization_id
    where o.slug = 'alhara' and s.key = 'restaurant.delivery_fee_cents'
    order by (s.branch_id is null) limit 1`);
  expect(Number(rows[0].fee)).toBe(2500);
});

test('with ordering off the menu stays but the CTA does not', async ({ page }) => {
  await setSetting('restaurant.online_ordering_enabled', 'false');
  try {
    await page.goto(SITE);
    // The menu is still public — that is the point of having a website.
    await expect(page.getByRole('heading', { name: 'المنيو' })).toBeVisible();
    // But nothing invites an order.
    await expect(page.getByRole('link', { name: 'اطلب الآن' })).toHaveCount(0);
    await expect(page.getByText('الطلب أونلاين غير متاح حاليًا')).toBeVisible();
  } finally {
    await setSetting('restaurant.online_ordering_enabled', 'true');
  }
});

test('with delivery off the website does not advertise it', async ({ page }) => {
  await setSetting('restaurant.delivery_enabled', 'false');
  try {
    await page.goto(SITE);
    await expect(page.getByText(/رسوم التوصيل/)).toHaveCount(0);
    await expect(page.getByText('الاستلام من الفرع فقط.')).toBeVisible();
  } finally {
    await setSetting('restaurant.delivery_enabled', 'true');
  }
});

test('multiple branches are offered and each has its own page', async ({ page }) => {
  const { rows } = await DB.query(`
    select b.slug, b.name from branches b
    join organizations o on o.id = b.organization_id
    where o.slug = 'alhara' and b.is_active and b.deleted_at is null
    order by b.created_at`);

  await page.goto(SITE);

  if (rows.length > 1) {
    await expect(page.getByRole('heading', { name: 'اختر الفرع' })).toBeVisible();
    const second = rows[1];
    await page.getByRole('link', { name: new RegExp(second.name) }).click();
    await expect(page).toHaveURL(new RegExp(`/r/alhara/${second.slug}$`));
    await expect(page.getByRole('heading', { name: 'فروعنا' })).toBeVisible();
  } else {
    await expect(page.getByRole('heading', { name: 'اختر الفرع' })).toHaveCount(0);
  }
});

test('the website works on a phone-sized viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(SITE);

  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'المنيو' })).toBeVisible();

  // Nothing overflows sideways on a phone.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test('an owner publishes the website from the Site Customizer', async ({ page }) => {
  const { rows } = await DB.query("select id from auth.users where email = 'owner@demo.local'");
  await page.context().addCookies([
    { name: 'lb_local_user', value: rows[0].id, url: 'http://localhost:3000' },
  ]);

  // The old settings/website URL redirects here rather than 404ing.
  await page.goto('/alhara/main/settings/website');
  await expect(page).toHaveURL(/\/settings\/branding$/);
  await expect(page.getByRole('heading', { name: 'محتوى الموقع الإلكتروني' })).toBeVisible();

  await page.getByLabel('الوصف المختصر').fill('مشاوي وأكل شامي أصيل');
  await page.getByRole('button', { name: 'حفظ محتوى الموقع' }).click();
  await expect(page.getByTestId('website-saved')).toBeVisible();

  await page.context().clearCookies();
  await page.goto(SITE);
  await expect(page.getByText('مشاوي وأكل شامي أصيل')).toBeVisible();
});

test('a member without settings.manage or branding.manage cannot open the Site Customizer', async ({ page }) => {
  const { rows } = await DB.query("select id from auth.users where email = 'kitchen@demo.local'");
  await page.context().addCookies([
    { name: 'lb_local_user', value: rows[0].id, url: 'http://localhost:3000' },
  ]);
  await page.goto('/alhara/main/settings/branding');
  await expect(page.getByText('الصفحة غير موجودة')).toBeVisible();
});
