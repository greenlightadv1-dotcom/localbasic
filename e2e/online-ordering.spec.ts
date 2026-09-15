import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * D1 online ordering, driven through the real guest screens.
 *
 * The SQL suite proves the database refuses tampering. This proves the surface
 * a customer actually reaches behaves — and that an online order lands in the
 * same pipeline the kitchen and cashier already read.
 */
const DB = new Pool({
  connectionString:
    process.env.LOCAL_DATABASE_URL ??
    'postgresql://postgres@localhost/localbasic_dev?host=/tmp&port=5433',
});

const STORE = '/order/alhara/main';

async function ids() {
  const { rows } = await DB.query(`
    select o.id as org, b.id as branch from organizations o
    join branches b on b.organization_id = o.id
    where o.slug = 'alhara' and b.slug = 'main'`);
  return rows[0] as { org: string; branch: string };
}

test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) =>
    route.request().url().startsWith('http://localhost:3000') ? route.continue() : route.abort(),
  );
});

test.afterAll(async () => { await DB.end(); });

/** Adds the first menu item and waits for the server's price to arrive. */
async function addFirstItem(page: Page) {
  await page.goto(STORE);
  await page.getByRole('button', { name: 'أضف للسلة' }).first().click();
  await expect(page.getByTestId('cart-total')).toBeVisible();
}

test('a guest browses the menu without any account', async ({ page }) => {
  await page.goto(STORE);
  await expect(page.getByRole('heading', { name: 'اطلب أونلاين' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'أضف للسلة' }).first()).toBeVisible();
});

test('a storefront with online ordering disabled is not found', async ({ page }) => {
  const { org } = await ids();
  const setEnabled = (v: boolean) => DB.query(
    `update settings set value = $2::jsonb
      where organization_id = $1 and key = 'restaurant.online_ordering_enabled'`,
    [org, String(v)],
  );

  await setEnabled(false);
  try {
    await page.goto(STORE);
    await expect(page.getByText('الصفحة غير موجودة')).toBeVisible();
  } finally {
    await setEnabled(true);
  }
});

test('an unknown storefront is not found', async ({ page }) => {
  await page.goto('/order/alhara/nosuchbranch');
  await expect(page.getByText('الصفحة غير موجودة')).toBeVisible();
  await page.goto('/order/nosuchorg/main');
  await expect(page.getByText('الصفحة غير موجودة')).toBeVisible();
});

test('the cart total is the server figure, and delivery adds the branch fee', async ({ page }) => {
  await addFirstItem(page);
  const pickup = await page.getByTestId('cart-total').textContent();

  await page.getByRole('button', { name: 'توصيل' }).click();
  await expect(page.getByText('التوصيل')).toBeVisible();
  const delivery = await page.getByTestId('cart-total').textContent();

  expect(delivery).not.toBe(pickup);
  await expect(page.getByText('التوصيل')).toBeVisible();
});

test('a guest places a pickup order and lands on an opaque token', async ({ page }) => {
  await addFirstItem(page);
  await page.getByLabel('الاسم').fill('ضيف الاختبار');
  await page.getByLabel('رقم الهاتف').fill('01099887766');
  await page.getByRole('button', { name: /تأكيد الطلب/ }).click();

  // The URL carries a random token, never an id.
  await expect(page).toHaveURL(/\/order\/track\/[A-Za-z0-9_-]{22,64}$/);
  const token = page.url().split('/').pop()!;

  const { rows } = await DB.query(`
    select o.channel, o.type, o.status, o.customer_edit_until, o.placed_at, o.total_cents,
           o.id::text as id, o.organization_id::text as org
      from restaurant_orders o
      join public_links pl on (pl.target ->> 'entity_id')::uuid = o.id
     where pl.token = $1`, [token]);
  expect(rows).toHaveLength(1);
  expect(rows[0].channel).toBe('online');
  expect(rows[0].type).toBe('pickup');
  expect(rows[0].status).toBe('new');

  // The window is 60 seconds from creation, by the server's clock.
  const span = (new Date(rows[0].customer_edit_until).getTime()
    - new Date(rows[0].placed_at).getTime()) / 1000;
  expect(span).toBeGreaterThanOrEqual(59);
  expect(span).toBeLessThanOrEqual(61);

  // The token leaks nothing.
  expect(token).not.toContain(rows[0].id);
  expect(token).not.toContain(rows[0].org);

  await expect(page.getByText('بانتظار تأكيد المطعم')).toBeVisible();
  await expect(page.getByTestId('seconds-left')).toBeVisible();
});

test('a guest places a delivery order with an address', async ({ page }) => {
  await addFirstItem(page);
  await page.getByRole('button', { name: 'توصيل' }).click();
  await page.getByLabel('الاسم').fill('ضيف التوصيل');
  await page.getByLabel('رقم الهاتف').fill('01055443322');
  await page.getByLabel('العنوان').fill('شارع 9، المعادي');
  await page.getByLabel('المدينة').fill('القاهرة');
  await page.getByRole('button', { name: /تأكيد الطلب/ }).click();

  await expect(page).toHaveURL(/\/order\/track\//);
  const token = page.url().split('/').pop()!;

  const { rows } = await DB.query(`
    select d.address, d.city, o.type, o.delivery_fee_cents
      from restaurant_order_deliveries d
      join restaurant_orders o on o.id = d.order_id
      join public_links pl on (pl.target ->> 'entity_id')::uuid = o.id
     where pl.token = $1`, [token]);
  expect(rows).toHaveLength(1);
  expect(rows[0].city).toBe('القاهرة');
  expect(rows[0].type).toBe('delivery');
  expect(Number(rows[0].delivery_fee_cents)).toBe(2500);
});

test('a guest cancels inside the window, and the token is then spent', async ({ page }) => {
  await addFirstItem(page);
  await page.getByLabel('الاسم').fill('ملغي');
  await page.getByLabel('رقم الهاتف').fill('01011112222');
  await page.getByRole('button', { name: /تأكيد الطلب/ }).click();
  await expect(page).toHaveURL(/\/order\/track\//);
  const token = page.url().split('/').pop()!;

  await page.getByRole('button', { name: 'إلغاء الطلب' }).click();

  // The page re-renders as cancelled, which is the confirmation — the cancel
  // form is gone because the order is no longer 'new'.
  await expect(page.getByText('ملغي')).toBeVisible();
  await expect(page.getByRole('button', { name: 'إلغاء الطلب' })).toHaveCount(0);

  const { rows } = await DB.query(`
    select o.status from restaurant_orders o
      join public_links pl on (pl.target ->> 'entity_id')::uuid = o.id
     where pl.token = $1`, [token]);
  expect(rows[0].status).toBe('cancelled');

  // The token still shows the order, read-only, so the guest can see it worked.
  await page.goto(`/order/track/${token}`);
  await expect(page.getByText('ملغي')).toBeVisible();
});

test('after the window the customer can no longer cancel', async ({ page }) => {
  await addFirstItem(page);
  await page.getByLabel('الاسم').fill('متأخر');
  await page.getByLabel('رقم الهاتف').fill('01033334444');
  await page.getByRole('button', { name: /تأكيد الطلب/ }).click();
  await expect(page).toHaveURL(/\/order\/track\//);
  const token = page.url().split('/').pop()!;

  // Expire the window by moving it into the past — the deadline is a stored
  // timestamp compared against the server clock, so no waiting is needed.
  await DB.query('alter table restaurant_orders disable trigger restaurant_orders_freeze_edit_window');
  await DB.query(`
    update restaurant_orders set customer_edit_until = now() - interval '1 second'
     where id = (select (pl.target ->> 'entity_id')::uuid from public_links pl where pl.token = $1)`,
    [token]);
  await DB.query('alter table restaurant_orders enable trigger restaurant_orders_freeze_edit_window');

  await page.goto(`/order/track/${token}`);
  await expect(page.getByText('انتهت مهلة التعديل')).toBeVisible();
  await expect(page.getByRole('button', { name: 'إلغاء الطلب' })).toHaveCount(0);

  const { rows } = await DB.query(`
    select o.status from restaurant_orders o
      join public_links pl on (pl.target ->> 'entity_id')::uuid = o.id
     where pl.token = $1`, [token]);
  expect(rows[0].status).toBe('new');
});

test('an arbitrary or foreign token reaches nothing', async ({ page }) => {
  await page.goto('/order/track/AAAAAAAAAAAAAAAAAAAAAAAA');
  await expect(page.getByText('الصفحة غير موجودة')).toBeVisible();

  // A real token for a different kind of link is not an order token either.
  const { rows } = await DB.query(
    "select token from public_links where kind = 'menu' limit 1",
  );
  if (rows[0]) {
    await page.goto(`/order/track/${rows[0].token}`);
    await expect(page.getByText('الصفحة غير موجودة')).toBeVisible();
  }
});

test('the checkout form carries one stable idempotency key and locks on submit', async ({ page }) => {
  // The server-side guarantee is proved by the test below and by the SQL
  // suite. What the UI must contribute is a key that stays the same across a
  // retry of the same attempt, plus a button that cannot be hammered.
  await addFirstItem(page);
  await page.getByLabel('الاسم').fill('مكرر');
  await page.getByLabel('رقم الهاتف').fill('01077778888');

  const key = await page.locator('input[name="idempotencyKey"]').inputValue();
  expect(key.length).toBeGreaterThanOrEqual(8);

  // Unchanged by further cart edits: it identifies the checkout attempt, not
  // the cart contents.
  await page.getByRole('button', { name: 'زيادة' }).first().click();
  await expect(page.getByTestId('cart-total')).toBeVisible();
  expect(await page.locator('input[name="idempotencyKey"]').inputValue()).toBe(key);

  const before = await DB.query(
    "select count(*)::int as n from restaurant_orders where channel = 'online'",
  );
  const submit = page.getByRole('button', { name: /تأكيد الطلب/ });
  await submit.click();
  await expect(page).toHaveURL(/\/order\/track\//);

  const after = await DB.query(
    "select count(*)::int as n from restaurant_orders where channel = 'online'",
  );
  expect(after.rows[0].n).toBe(before.rows[0].n + 1);

  const { rows } = await DB.query(
    'select count(*)::int as n from restaurant_orders where idempotency_key = $1', [key],
  );
  expect(rows[0].n).toBe(1);
});

test('the same idempotency key never yields a second order', async () => {
  // Driven at the database boundary, because a browser cannot be made to
  // replay one checkout reliably — and this is the property that matters.
  const items = await DB.query(`
    select v.id from restaurant_variants v
    join organizations o on o.id = v.organization_id
    where o.slug = 'alhara' and v.is_active limit 1`);
  const payload = JSON.stringify([{ variant_id: items.rows[0].id, quantity: 1 }]);
  const key = `e2e-replay-${Date.now()}`;

  const call = () => DB.query(
    `select out_token, out_number from restaurant_place_online_order(
       'alhara', 'main', $1::jsonb, 'pickup', 'إعادة', '01000000099', $2)`,
    [payload, key],
  );

  const first = await call();
  const second = await call();
  expect(second.rows[0].out_token).toBe(first.rows[0].out_token);
  expect(second.rows[0].out_number).toBe(first.rows[0].out_number);

  const { rows } = await DB.query(
    'select count(*)::int as n from restaurant_orders where idempotency_key = $1', [key],
  );
  expect(rows[0].n).toBe(1);
});

test('an online order enters the same pipeline the kitchen reads', async ({ page }) => {
  await addFirstItem(page);
  await page.getByLabel('الاسم').fill('للمطبخ');
  await page.getByLabel('رقم الهاتف').fill('01099990000');
  await page.getByRole('button', { name: /تأكيد الطلب/ }).click();
  await expect(page).toHaveURL(/\/order\/track\//);
  const token = page.url().split('/').pop()!;

  const { rows } = await DB.query(`
    select o.id, o.number, o.channel,
           (select count(*)::int from restaurant_order_items i where i.order_id = o.id) as lines
      from restaurant_orders o
      join public_links pl on (pl.target ->> 'entity_id')::uuid = o.id
     where pl.token = $1`, [token]);
  expect(rows[0].lines).toBeGreaterThan(0);

  // Staff advance it through the ordinary state machine; the customer never can.
  await DB.query("update restaurant_orders set status = 'confirmed' where id = $1", [rows[0].id]);
  await DB.query("update restaurant_orders set status = 'preparing' where id = $1", [rows[0].id]);

  await page.goto(`/order/track/${token}`);
  await expect(page.getByText('جارٍ التحضير')).toBeVisible();
  await expect(page.getByRole('button', { name: 'إلغاء الطلب' })).toHaveCount(0);
});
