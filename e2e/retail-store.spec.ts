import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * The retail online store, driven through the real screens.
 *
 * The SQL suite proves the database refuses overselling, cross-tenant access
 * and cart-supplied prices. This proves the journey that matters commercially:
 * a stranger shops, checks out, and follows their order — while the shop sees
 * it, moves it along, and turns it into a receipt with the money in the
 * treasury. And that the stock the storefront took is the stock the POS sees.
 */
const DB = new Pool({
  connectionString:
    process.env.LOCAL_DATABASE_URL ??
    'postgresql://postgres@localhost/localbasic_dev?host=/tmp&port=5433',
});

const SLUG = 'retailstore';
const OWNER = 'retailstore-owner@demo.local';
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

/**
 * Money renders with Arabic-Indic digits in an RTL locale, which is correct
 * and is not something a test should assert around. Read the number instead.
 */
function toLatinDigits(text: string): string {
  return text.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

async function stockOnHand(): Promise<number> {
  const { rows } = await DB.query(
    'select coalesce(quantity, 0) as q from retail_stock_levels where branch_id = $1 and variant_id = $2',
    [branchId, variantId],
  );
  return rows.length ? Number(rows[0].q) : 0;
}

test.beforeAll(async () => {
  await asAdmin('delete from organizations where slug = $1', [SLUG]).catch(() => undefined);
  await asAdmin('delete from auth.users where email = $1', [OWNER]).catch(() => undefined);

  const { rows: users } = await asAdmin(
    'insert into auth.users (email) values ($1) returning id',
    [OWNER],
  );
  ownerId = users[0].id;
  await asAdmin(
    `insert into public.profiles (id, full_name) values ($1, 'صاحب المتجر')
     on conflict (id) do nothing`,
    [ownerId],
  );

  // Provisioned the way the product does it, under the owner's own session,
  // inside one transaction so the identity is in force and does not leak.
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
         from public.provision_workspace('متجر أونلاين', $1, 'retail')`,
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
     values ($1, 'قميص قطن', 0, true) returning id`,
    [orgId],
  );
  const { rows: variant } = await asAdmin(
    `insert into public.retail_variants
       (organization_id, product_id, name, sku, price_cents, cost_cents)
     values ($1, $2, 'وسط', 'SHIRT-M', 20000, 12000) returning id`,
    [orgId, product[0].id],
  );
  variantId = variant[0].id;

  // A product the shop deliberately keeps off the storefront.
  const { rows: hidden } = await asAdmin(
    `insert into public.retail_products (organization_id, name, is_online)
     values ($1, 'بضاعة داخلية', false) returning id`,
    [orgId],
  );
  await asAdmin(
    `insert into public.retail_variants (organization_id, product_id, price_cents)
     values ($1, $2, 5000)`,
    [orgId, hidden[0].id],
  );
});

test.afterAll(async () => {
  if (orgId) await asAdmin('delete from organizations where id = $1', [orgId]);
  if (ownerId) await asAdmin('delete from auth.users where id = $1', [ownerId]);
  await DB.end();
});

test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) =>
    route.request().url().startsWith('http://localhost:3000') ? route.continue() : route.abort(),
  );
  await asAdmin('delete from retail_orders where organization_id = $1', [orgId]);
  await asAdmin('delete from retail_stock_movements where organization_id = $1', [orgId]);
  await asAdmin('delete from retail_stock_levels where organization_id = $1', [orgId]);
  await asAdmin('delete from treasury_transactions where organization_id = $1', [orgId]);
  // Payments reference invoices, so they go first.
  await asAdmin('delete from payments where organization_id = $1', [orgId]);
  await asAdmin('delete from invoices where organization_id = $1', [orgId]);
  // Ten on the shelf, through the ledger, the way everything else does it.
  await asAdmin(
    `insert into retail_stock_movements
       (organization_id, branch_id, variant_id, quantity_delta, reason)
     values ($1, $2, $3, 10, 'initial')`,
    [orgId, branchId, variantId],
  );
  // Branch-level overrides win over the organization defaults below, so a test
  // that sets one must not decide the next test's starting state.
  await asAdmin(
    `delete from settings
      where organization_id = $1 and branch_id = $2 and key like 'retail.%'`,
    [orgId, branchId],
  );
  await setSetting('retail.store_enabled', 'true');
  await setSetting('retail.pickup_enabled', 'true');
  await setSetting('retail.delivery_enabled', 'true');
  await setSetting('retail.delivery_fee_cents', '2500');
  await setSetting('retail.min_order_cents', '0');
});

// ---------------------------------------------------------------------------
// The storefront
// ---------------------------------------------------------------------------

test('a closed store is not found, and opening it makes the shop reachable', async ({ page }) => {
  await setSetting('retail.store_enabled', 'false');
  await page.goto(SHOP);
  await expect(page.getByTestId(`product-${variantId}`)).toHaveCount(0);

  await setSetting('retail.store_enabled', 'true');
  await page.goto(SHOP);
  await expect(page.getByRole('heading', { name: 'متجر أونلاين' })).toBeVisible();
  await expect(page.getByTestId(`product-${variantId}`)).toBeVisible();
});

test('the storefront shows only what the shop published', async ({ page }) => {
  await page.goto(SHOP);
  await expect(page.getByText('قميص قطن')).toBeVisible();
  // A product not marked is_online never reaches the storefront.
  await expect(page.getByText('بضاعة داخلية')).toHaveCount(0);
});

test('the basket total is the server’s, not the browser’s', async ({ page }) => {
  await page.goto(SHOP);
  await page.getByTestId(`add-${variantId}`).click();
  await page.getByTestId(`add-${variantId}`).click();

  // 2 × 200.00, pickup, no fee.
  await expect
    .poll(async () => toLatinDigits(await page.getByTestId('cart-total').innerText()))
    .toContain('400');

  // Switching to delivery adds the shop's own fee — a number the browser was
  // never told to compute.
  await page.getByLabel('طريقة الاستلام').selectOption('delivery');
  await expect
    .poll(async () => toLatinDigits(await page.getByTestId('cart-total').innerText()))
    .toContain('425');
});

test('a guest checks out and can follow the order with the token', async ({ page }) => {
  await page.goto(SHOP);
  await page.getByTestId(`add-${variantId}`).click();

  await page.getByLabel('الاسم').fill('زائر الحارة');
  await page.getByLabel('رقم الهاتف').fill('01000000000');
  await page.getByTestId('place-order').click();

  await expect(page).toHaveURL(/\/shop\/track\//);
  await expect(page.getByText('تم استلام الطلب')).toBeVisible();
  await expect(page.getByText('قميص قطن')).toBeVisible();

  // The required wording is on the customer's document.
  await expect(page.getByText(/هذا إيصال داخلي وليس فاتورة ضريبية/)).toBeVisible();

  // The stock left the shelf when the order was placed.
  expect(await stockOnHand()).toBe(9);

  // No money exists yet, because none has moved.
  const { rows: invoices } = await DB.query(
    'select count(*)::int as n from invoices where organization_id = $1',
    [orgId],
  );
  expect(invoices[0].n).toBe(0);
});

test('a delivery order needs an address and carries the fee', async ({ page }) => {
  await page.goto(SHOP);
  await page.getByTestId(`add-${variantId}`).click();
  await page.getByLabel('طريقة الاستلام').selectOption('delivery');

  await page.getByLabel('الاسم').fill('زائر التوصيل');
  await page.getByLabel('رقم الهاتف').fill('01000000002');
  await page.getByLabel('المدينة').fill('القاهرة');
  await page.getByLabel('العنوان').fill('شارع 9، عمارة 3، الدور الثاني');
  await page.getByTestId('place-order').click();

  await expect(page).toHaveURL(/\/shop\/track\//);

  const { rows } = await DB.query(
    `select o.total_cents, o.delivery_fee_cents, d.city
       from retail_orders o
       join retail_order_deliveries d on d.order_id = o.id
      where o.organization_id = $1`,
    [orgId],
  );
  expect(Number(rows[0].total_cents)).toBe(22500);
  expect(Number(rows[0].delivery_fee_cents)).toBe(2500);
  expect(rows[0].city).toBe('القاهرة');
});

test('the storefront cannot oversell what the shop has', async ({ page }) => {
  // One left on the shelf.
  await asAdmin(
    `insert into retail_stock_movements
       (organization_id, branch_id, variant_id, quantity_delta, reason)
     values ($1, $2, $3, -9, 'adjustment')`,
    [orgId, branchId, variantId],
  );
  expect(await stockOnHand()).toBe(1);

  await page.goto(SHOP);
  for (let i = 0; i < 3; i += 1) await page.getByTestId(`add-${variantId}`).click();

  await page.getByLabel('الاسم').fill('زائر طماع');
  await page.getByLabel('رقم الهاتف').fill('01000000003');
  await page.getByTestId('place-order').click();

  // Refused, and nothing moved: the same CHECK the till meets.
  await expect(page.getByRole('alert')).toBeVisible();
  expect(await stockOnHand()).toBe(1);

  const { rows } = await DB.query(
    'select count(*)::int as n from retail_orders where organization_id = $1',
    [orgId],
  );
  expect(rows[0].n).toBe(0);
});

// ---------------------------------------------------------------------------
// The shop's side
// ---------------------------------------------------------------------------

test('the shop works an order through to a receipt, and the money lands', async ({ page }) => {
  // A guest order, placed through the storefront.
  await page.goto(SHOP);
  await page.getByTestId(`add-${variantId}`).click();
  await page.getByLabel('الاسم').fill('زائر الحارة');
  await page.getByLabel('رقم الهاتف').fill('01000000000');
  await page.getByTestId('place-order').click();
  await expect(page).toHaveURL(/\/shop\/track\//);

  await actAs(page, ownerId);
  await page.goto(`${BASE}/store-orders`);
  await expect(page.getByText('زائر الحارة')).toBeVisible();
  await page.getByRole('link', { name: /\d/ }).first().click();

  // placed → confirmed → packed → fulfilled, one step at a time.
  for (const label of ['تأكيد الطلب', 'تم التجهيز', 'تم التسليم']) {
    await expect(page.getByTestId('advance-order')).toHaveText(label);
    await page.getByTestId('advance-order').click();
    await expect(page.getByTestId('advance-order')).not.toHaveText(label);
  }

  await page.getByTestId('complete-order').click();
  await expect(page.getByText('مكتمل')).toBeVisible();

  // The receipt exists, in Core, with the payment and the treasury entry.
  const { rows: invoice } = await DB.query(
    'select id, total_cents, status, source from invoices where organization_id = $1',
    [orgId],
  );
  expect(invoice).toHaveLength(1);
  expect(Number(invoice[0].total_cents)).toBe(20000);
  expect(invoice[0].source).toBe('online');
  expect(invoice[0].status).toBe('paid');

  const { rows: treasury } = await DB.query(
    `select direction, amount_cents from treasury_transactions
      where organization_id = $1 and ref_id = $2`,
    [orgId, invoice[0].id],
  );
  expect(treasury).toHaveLength(1);
  expect(treasury[0].direction).toBe('in');
  expect(Number(treasury[0].amount_cents)).toBe(20000);

  // Stock was taken at checkout and is NOT taken again at completion.
  expect(await stockOnHand()).toBe(9);
});

test('cancelling an order returns the stock to the shelf', async ({ page }) => {
  await page.goto(SHOP);
  await page.getByTestId(`add-${variantId}`).click();
  await page.getByTestId(`add-${variantId}`).click();
  await page.getByLabel('الاسم').fill('زائر متردد');
  await page.getByLabel('رقم الهاتف').fill('01000000004');
  await page.getByTestId('place-order').click();
  await expect(page).toHaveURL(/\/shop\/track\//);
  expect(await stockOnHand()).toBe(8);

  await actAs(page, ownerId);
  await page.goto(`${BASE}/store-orders`);
  await page.getByRole('link', { name: /\d/ }).first().click();
  await page.getByTestId('cancel-order').click();
  await page.getByTestId('cancel-order-confirm').click();
  await expect(page.getByText('ملغي')).toBeVisible();

  expect(await stockOnHand()).toBe(10);

  // Both facts survive: it took the stock, and it gave it back.
  const { rows } = await DB.query(
    `select count(*)::int as n from retail_stock_movements
      where organization_id = $1 and ref_type = 'retail_order'`,
    [orgId],
  );
  expect(rows[0].n).toBe(2);
});

test('the store settings screen opens and closes the shop', async ({ page }) => {
  await actAs(page, ownerId);
  await page.goto(`${BASE}/settings/store`);
  await expect(page.getByText('المتجر الإلكتروني').first()).toBeVisible();

  await page.getByTestId('store-enabled').uncheck();
  await page.getByRole('button', { name: 'حفظ' }).click();
  await expect(page.getByTestId('store-settings-saved')).toBeVisible();

  // And the storefront closes with it.
  await page.context().clearCookies();
  await page.goto(SHOP);
  await expect(page.getByTestId(`product-${variantId}`)).toHaveCount(0);
});
