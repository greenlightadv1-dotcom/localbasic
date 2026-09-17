import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * Shipping, driven through the real screens.
 *
 * The SQL suite proves the database copies the address, enforces the state
 * machine and keeps the carrier's cost out of the customer's fee. This proves
 * the flow a shop walks: a delivery order gets a parcel, the parcel moves, a
 * failure is recorded with its reason and retried as a NEW attempt, and what
 * the shop paid the carrier lands in the treasury.
 */
const DB = new Pool({
  connectionString:
    process.env.LOCAL_DATABASE_URL ??
    'postgresql://postgres@localhost/localbasic_dev?host=/tmp&port=5433',
});

const SLUG = 'retailship';
const OWNER = 'retailship-owner@demo.local';
const BASE = `/${SLUG}/main`;
const SHOP = `/shop/${SLUG}/main`;

let orgId = '';
let branchId = '';
let ownerId = '';
let variantId = '';

async function asAdmin(sql: string, params: unknown[] = []) {
  return DB.query(sql, params);
}

async function actAs(page: Page, userId: string) {
  await page.context().addCookies([
    { name: 'lb_local_user', value: userId, url: 'http://localhost:3000' },
  ]);
}

async function setSetting(key: string, value: string) {
  await asAdmin(
    `insert into settings (organization_id, branch_id, key, value)
     values ($1, null, $2, $3::jsonb)
     on conflict (organization_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), key)
     do update set value = excluded.value`,
    [orgId, key, value],
  );
}

test.beforeAll(async () => {
  await asAdmin('delete from organizations where slug = $1', [SLUG]).catch(() => undefined);

  const { rows: users } = await asAdmin(
    `insert into auth.users (email) values ($1)
     on conflict (email) do update set email = excluded.email returning id`,
    [OWNER],
  );
  ownerId = users[0].id;
  await asAdmin(
    `insert into public.profiles (id, full_name) values ($1, 'صاحب المتجر')
     on conflict (id) do nothing`,
    [ownerId],
  );

  const client = await DB.connect();
  try {
    await client.query('begin');
    await client.query(
      `select set_config('request.jwt.claims',
         json_build_object('sub', $1::text, 'role', 'authenticated')::text, true),
              set_config('role', 'authenticated', true)`,
      [ownerId],
    );
    const { rows: ws } = await client.query(
      `select out_organization_id, out_branch_id
         from public.provision_workspace('متجر الشحن', $1, 'retail')`,
      [SLUG],
    );
    orgId = ws[0].out_organization_id;
    branchId = ws[0].out_branch_id;
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  const { rows: product } = await asAdmin(
    `insert into public.retail_products (organization_id, name, tax_rate_bp, is_online)
     values ($1, 'حقيبة', 0, true) returning id`,
    [orgId],
  );
  const { rows: variant } = await asAdmin(
    `insert into public.retail_variants (organization_id, product_id, name, price_cents, cost_cents)
     values ($1, $2, 'وسط', 30000, 18000) returning id`,
    [orgId, product[0].id],
  );
  variantId = variant[0].id;
});

test.afterAll(async () => {
  if (orgId) await asAdmin('delete from organizations where id = $1', [orgId]);
  await DB.end();
});

test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) =>
    route.request().url().startsWith('http://localhost:3000') ? route.continue() : route.abort(),
  );
  await asAdmin('delete from retail_shipments where organization_id = $1', [orgId]);
  await asAdmin('delete from retail_shipping_providers where organization_id = $1', [orgId]);
  await asAdmin('delete from treasury_transactions where organization_id = $1', [orgId]);
  await asAdmin('delete from retail_orders where organization_id = $1', [orgId]);
  await asAdmin('delete from retail_stock_movements where organization_id = $1', [orgId]);
  await asAdmin('delete from retail_stock_levels where organization_id = $1', [orgId]);
  await asAdmin(
    `insert into retail_stock_movements
       (organization_id, branch_id, variant_id, quantity_delta, reason)
     values ($1, $2, $3, 20, 'initial')`,
    [orgId, branchId, variantId],
  );
  await asAdmin(
    "delete from settings where organization_id = $1 and branch_id = $2 and key like 'retail.%'",
    [orgId, branchId],
  );
  await setSetting('retail.store_enabled', 'true');
  await setSetting('retail.delivery_enabled', 'true');
  await setSetting('retail.delivery_fee_cents', '2500');
});

/** Places a delivery order through the storefront and returns its id. */
async function placeDeliveryOrder(page: Page): Promise<string> {
  await page.goto(SHOP);
  await page.getByTestId(`add-${variantId}`).click();
  await page.getByLabel('طريقة الاستلام').selectOption('delivery');
  await page.getByLabel('الاسم').fill('زائر التوصيل');
  await page.getByLabel('رقم الهاتف').fill('01000000000');
  await page.getByLabel('المدينة').fill('القاهرة');
  await page.getByLabel('العنوان').fill('شارع 9، عمارة 3');
  await page.getByTestId('place-order').click();
  await expect(page).toHaveURL(/\/shop\/track\//);

  const { rows } = await DB.query(
    'select id from retail_orders where organization_id = $1 order by placed_at desc limit 1',
    [orgId],
  );
  return rows[0].id as string;
}

async function addCarrier(name = 'مندوب المتجر', costCents = 4000) {
  await asAdmin(
    `insert into retail_shipping_providers
       (organization_id, provider_key, name, default_cost_cents)
     values ($1, 'manual', $2, $3)`,
    [orgId, name, costCents],
  );
}

// ---------------------------------------------------------------------------

test('a shop adds a carrier from the store settings', async ({ page }) => {
  await actAs(page, ownerId);
  await page.goto(`${BASE}/settings/store`);
  await expect(page.getByText('شركات الشحن')).toBeVisible();

  await page.getByLabel('اسم شركة الشحن').fill('مندوب المتجر');
  await page.getByLabel('التكلفة الافتراضية').fill('40.00');
  await page.getByTestId('add-carrier').click();

  await expect(page.getByTestId('carrier-list')).toContainText('مندوب المتجر');

  const { rows } = await DB.query(
    'select provider_key, default_cost_cents from retail_shipping_providers where organization_id = $1',
    [orgId],
  );
  expect(rows[0].provider_key).toBe('manual');
  expect(Number(rows[0].default_cost_cents)).toBe(4000);
});

test('a delivery order gets a parcel addressed from the order itself', async ({ page }) => {
  await addCarrier();
  const orderId = await placeDeliveryOrder(page);

  await actAs(page, ownerId);
  await page.goto(`${BASE}/store-orders/${orderId}`);
  await expect(page.getByRole('heading', { name: 'الشحن' })).toBeVisible();
  await expect(page.getByText('لم تُرسل شحنة بعد.')).toBeVisible();

  await page.getByTestId('create-shipment').click();
  await expect(page.getByTestId('shipment-list')).toBeVisible();
  await expect(page.getByTestId('shipment-list')).toContainText('بانتظار الإرسال');

  // The address came from the order, not from anything the screen submitted.
  const { rows } = await DB.query(
    'select recipient_name, city, address_line, cost_cents from retail_shipments where organization_id = $1',
    [orgId],
  );
  expect(rows[0].recipient_name).toBe('زائر التوصيل');
  expect(rows[0].city).toBe('القاهرة');
  expect(rows[0].address_line).toContain('شارع 9، عمارة 3');
  // The carrier's default cost, not the customer's delivery fee.
  expect(Number(rows[0].cost_cents)).toBe(4000);

  // And the manual carrier invented no tracking number.
  await expect(page.getByText('لا يوجد رقم تتبّع.')).toBeVisible();
});

test('a pickup order is never offered shipping', async ({ page }) => {
  await addCarrier();
  await page.goto(SHOP);
  await page.getByTestId(`add-${variantId}`).click();
  await page.getByLabel('الاسم').fill('زائر الاستلام');
  await page.getByLabel('رقم الهاتف').fill('01000000001');
  await page.getByTestId('place-order').click();
  await expect(page).toHaveURL(/\/shop\/track\//);

  const { rows } = await DB.query(
    'select id from retail_orders where organization_id = $1 order by placed_at desc limit 1',
    [orgId],
  );

  await actAs(page, ownerId);
  await page.goto(`${BASE}/store-orders/${rows[0].id}`);
  await expect(page.getByTestId('create-shipment')).toHaveCount(0);
});

test('a parcel moves, and a failure is recorded with its reason', async ({ page }) => {
  await addCarrier();
  const orderId = await placeDeliveryOrder(page);

  await actAs(page, ownerId);
  await page.goto(`${BASE}/store-orders/${orderId}`);
  await page.getByTestId('create-shipment').click();
  await expect(page.getByTestId('shipment-list')).toContainText('بانتظار الإرسال');

  await page.getByTestId('dispatch-shipment').click();
  await expect(page.getByTestId('shipment-list')).toContainText('في الطريق');

  // A failure has to say why — the button alone is not enough.
  await page.getByTestId('fail-shipment').click();
  await expect(page.getByTestId('confirm-failure')).toBeDisabled();
  await page.getByTestId('failure-reason').fill('العميل لم يرد');
  await page.getByTestId('confirm-failure').click();
  await expect(page.getByTestId('shipment-list')).toContainText('تعذّر التسليم');
  await expect(page.getByTestId('shipment-list')).toContainText('العميل لم يرد');

  // The retry is a NEW attempt; the failed one stays on the record. The form
  // only reappears once the failed parcel is no longer in flight, so wait for
  // it rather than racing the refresh.
  await expect(page.getByTestId('create-shipment')).toBeVisible();
  await page.getByTestId('create-shipment').click();
  await expect(page.getByTestId('shipment-list')).toContainText('بانتظار الإرسال');
  const { rows } = await DB.query(
    'select status from retail_shipments where organization_id = $1 order by created_at',
    [orgId],
  );
  expect(rows).toHaveLength(2);
  expect(rows[0].status).toBe('failed');
  expect(rows[1].status).toBe('pending');
});

test('what the shop pays the carrier lands in the treasury', async ({ page }) => {
  await addCarrier();
  const orderId = await placeDeliveryOrder(page);

  await actAs(page, ownerId);
  await page.goto(`${BASE}/store-orders/${orderId}`);
  await page.getByTestId('create-shipment').click();
  await page.getByTestId('dispatch-shipment').click();
  await expect(page.getByTestId('shipment-list')).toContainText('في الطريق');
  await page.getByTestId('deliver-shipment').click();
  await expect(page.getByTestId('shipment-list')).toContainText('تم التسليم');

  await page.getByTestId('pay-shipment').click();
  await expect(page.getByText('تمت تسوية التكلفة')).toBeVisible();

  const { rows } = await DB.query(
    `select direction, amount_cents, category from treasury_transactions
      where organization_id = $1 and ref_type = 'retail_shipment'`,
    [orgId],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].direction).toBe('out');
  expect(Number(rows[0].amount_cents)).toBe(4000);
  expect(rows[0].category).toBe('shipping');

  // The customer's delivery fee is a separate number and is untouched.
  const { rows: order } = await DB.query(
    'select delivery_fee_cents from retail_orders where id = $1',
    [orderId],
  );
  expect(Number(order[0].delivery_fee_cents)).toBe(2500);

  // Settled once.
  await expect(page.getByTestId('pay-shipment')).toHaveCount(0);
});

test('a member without order permission sees no shipping', async ({ page, context }) => {
  await addCarrier();
  const orderId = await placeDeliveryOrder(page);

  const email = `retailship-clerk-${Date.now().toString(36)}@demo.local`;
  const { rows } = await asAdmin(
    'insert into auth.users (email) values ($1) returning id',
    [email],
  );
  const clerkId = rows[0].id as string;
  await asAdmin(
    `insert into public.profiles (id, full_name) values ($1, 'موظف') on conflict (id) do nothing`,
    [clerkId],
  );
  const { rows: member } = await asAdmin(
    `insert into public.organization_members (organization_id, user_id, status)
     values ($1, $2, 'active') returning id`,
    [orgId, clerkId],
  );
  await asAdmin('insert into public.member_branches (member_id, branch_id) values ($1, $2)', [
    member[0].id, branchId,
  ]);

  await context.clearCookies();
  await actAs(page, clerkId);
  await page.goto(`${BASE}/store-orders/${orderId}`);

  await expect(page.getByTestId('create-shipment')).toHaveCount(0);
  await expect(page.getByTestId('shipment-list')).toHaveCount(0);

  await asAdmin('delete from organization_members where id = $1', [member[0].id]);
});
