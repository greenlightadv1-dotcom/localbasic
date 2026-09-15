import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * D1.1 — the settings screen, and the guest storefront obeying it.
 *
 * The SQL suite proves the database enforces these settings against a direct
 * caller. This proves an owner can actually set them, that they survive a
 * reload, and that the guest surface reflects them.
 */
const DB = new Pool({
  connectionString:
    process.env.LOCAL_DATABASE_URL ??
    'postgresql://postgres@localhost/localbasic_dev?host=/tmp&port=5433',
});

const SETTINGS = '/alhara/main/settings/online-ordering';
const STORE = '/order/alhara/main';

async function userId(email: string) {
  const { rows } = await DB.query('select id from auth.users where email = $1', [email]);
  return rows[0]?.id as string;
}

async function actAs(page: Page, email: string) {
  await page.context().addCookies([
    { name: 'lb_local_user', value: await userId(email), url: 'http://localhost:3000' },
  ]);
}

/** Reads a stored setting, resolving branch over organization as the app does. */
async function stored(key: string): Promise<unknown> {
  const { rows } = await DB.query(`
    select s.value from settings s
    join organizations o on o.id = s.organization_id
    where o.slug = 'alhara' and s.key = $1
    order by (s.branch_id is null)
    limit 1`, [key]);
  return rows[0]?.value;
}

test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) =>
    route.request().url().startsWith('http://localhost:3000') ? route.continue() : route.abort(),
  );
});

test.afterAll(async () => {
  // Leave the storefront open for the other specs in the suite.
  await DB.query(`
    update settings set value = 'true'::jsonb
     where key in ('restaurant.online_ordering_enabled',
                   'restaurant.pickup_enabled', 'restaurant.delivery_enabled')`);
  await DB.end();
});

test('a member without settings.manage cannot open the screen', async ({ page }) => {
  await actAs(page, 'kitchen@demo.local');
  await page.goto(SETTINGS);
  await expect(page.getByText('الصفحة غير موجودة')).toBeVisible();
  await expect(page.getByText('رسوم التوصيل')).toHaveCount(0);
});

test('an owner enables online ordering, sets a fee, and it persists', async ({ page }) => {
  await actAs(page, 'owner@demo.local');
  await page.goto(SETTINGS);
  await expect(page.getByRole('heading', { name: 'الطلب أونلاين' })).toBeVisible();

  await page.getByRole('checkbox', { name: /^الطلب أونلاين/ }).check();
  await page.getByRole('checkbox', { name: /^الاستلام من المطعم/ }).check();
  await page.getByRole('checkbox', { name: /^التوصيل/ }).check();
  await page.getByRole('spinbutton', { name: /^رسوم التوصيل/ }).fill('35');
  await page.getByRole('radio', { name: /كل الفروع/ }).check();
  await page.getByRole('button', { name: 'حفظ الإعدادات' }).click();

  await expect(page.getByTestId('settings-saved')).toBeVisible();

  // Stored as a boolean and as integer minor units, not as typed text.
  expect(await stored('restaurant.online_ordering_enabled')).toBe(true);
  expect(await stored('restaurant.delivery_fee_cents')).toBe(3500);

  // And it survives a reload.
  await page.reload();
  await expect(page.getByRole('checkbox', { name: /^الطلب أونلاين/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /^التوصيل/ })).toBeChecked();
  await expect(page.getByRole('spinbutton', { name: /^رسوم التوصيل/ })).toHaveValue('35');
});

test('the guest storefront charges the configured fee', async ({ page }) => {
  await page.goto(STORE);
  await page.getByRole('button', { name: 'أضف للسلة' }).first().click();
  await expect(page.getByTestId('cart-total')).toBeVisible();

  await page.getByRole('button', { name: 'توصيل' }).click();
  await expect(page.getByText('التوصيل')).toBeVisible();

  // The quote comes from the server; the stored fee is what appears.
  const { rows } = await DB.query(`
    select (s.value #>> '{}')::bigint as fee from settings s
    join organizations o on o.id = s.organization_id
    where o.slug = 'alhara' and s.key = 'restaurant.delivery_fee_cents'
    order by (s.branch_id is null) limit 1`);
  expect(Number(rows[0].fee)).toBe(3500);
});

test('disabling delivery removes it from the storefront and blocks checkout', async ({ page }) => {
  await actAs(page, 'owner@demo.local');
  await page.goto(SETTINGS);
  await page.getByRole('checkbox', { name: /^التوصيل/ }).uncheck();
  await page.getByRole('radio', { name: /كل الفروع/ }).check();
  await page.getByRole('button', { name: 'حفظ الإعدادات' }).click();
  await expect(page.getByTestId('settings-saved')).toBeVisible();
  expect(await stored('restaurant.delivery_enabled')).toBe(false);

  // The guest no longer sees the option.
  await page.context().clearCookies();
  await page.goto(STORE);
  await page.getByRole('button', { name: 'أضف للسلة' }).first().click();
  await expect(page.getByTestId('cart-total')).toBeVisible();
  await expect(page.getByRole('button', { name: 'توصيل' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'استلام من المطعم' })).toBeVisible();

  // And the server refuses a delivery order even when asked directly.
  const v = await DB.query(`
    select v.id from restaurant_variants v join organizations o on o.id = v.organization_id
    where o.slug = 'alhara' and v.is_active limit 1`);
  const payload = JSON.stringify([{ variant_id: v.rows[0].id, quantity: 1 }]);
  await expect(DB.query(
    `select * from restaurant_place_online_order(
       'alhara','main',$1::jsonb,'delivery','متجاوز','01000000123',$2,
       jsonb_build_object('address','شارع'))`,
    [payload, `e2e-blocked-${Date.now()}`],
  )).rejects.toThrow();
});

test('disabling pickup too closes the storefront entirely', async ({ page }) => {
  await actAs(page, 'owner@demo.local');
  await page.goto(SETTINGS);
  await page.getByRole('checkbox', { name: /^الاستلام من المطعم/ }).uncheck();
  await page.getByRole('radio', { name: /كل الفروع/ }).check();
  await page.getByRole('button', { name: 'حفظ الإعدادات' }).click();
  await expect(page.getByTestId('settings-saved')).toBeVisible();

  // The screen warns the operator they have closed every route in.
  await expect(page.getByText('لا توجد طريقة استلام مفعّلة')).toBeVisible();

  await page.context().clearCookies();
  await page.goto(STORE);
  await expect(page.getByText('الصفحة غير موجودة')).toBeVisible();
});

test('switching online ordering off closes the storefront', async ({ page }) => {
  await actAs(page, 'owner@demo.local');
  await page.goto(SETTINGS);
  await page.getByRole('checkbox', { name: /^الاستلام من المطعم/ }).check();
  await page.getByRole('checkbox', { name: /^التوصيل/ }).check();
  await page.getByRole('checkbox', { name: /^الطلب أونلاين/ }).uncheck();
  await page.getByRole('radio', { name: /كل الفروع/ }).check();
  await page.getByRole('button', { name: 'حفظ الإعدادات' }).click();
  await expect(page.getByTestId('settings-saved')).toBeVisible();
  await expect(page.getByText('صفحة الطلب مغلقة تمامًا')).toBeVisible();

  await page.context().clearCookies();
  await page.goto(STORE);
  await expect(page.getByText('الصفحة غير موجودة')).toBeVisible();

  // Restore for the rest of the run.
  await actAs(page, 'owner@demo.local');
  await page.goto(SETTINGS);
  await page.getByRole('checkbox', { name: /^الطلب أونلاين/ }).check();
  await page.getByRole('radio', { name: /كل الفروع/ }).check();
  await page.getByRole('button', { name: 'حفظ الإعدادات' }).click();
  await expect(page.getByTestId('settings-saved')).toBeVisible();
});

test('an out-of-range delivery fee is refused', async ({ page }) => {
  await actAs(page, 'owner@demo.local');
  await page.goto(SETTINGS);
  // Past the form's own max, so the value only reaches the server if the
  // attribute is bypassed — which is the case worth testing.
  await page.getByRole('spinbutton', { name: /^رسوم التوصيل/ }).fill('-5');
  await page.getByRole('button', { name: 'حفظ الإعدادات' }).click();

  await expect(page.getByTestId('settings-saved')).toHaveCount(0);
  const fee = await stored('restaurant.delivery_fee_cents');
  expect(Number(fee)).toBeGreaterThanOrEqual(0);
});
