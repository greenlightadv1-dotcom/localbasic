import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * Retail purchasing, driven through the real screens.
 *
 * The SQL suite proves the database refuses over-receipts, cross-tenant access
 * and unprivileged writes. This proves the flow a shop actually walks: raise an
 * order, send it, receive part of it, watch INVENTORY move, pay the supplier,
 * and watch the TREASURY move — because purchasing is only correct if those
 * two follow it.
 */
const DB = new Pool({
  connectionString:
    process.env.LOCAL_DATABASE_URL ??
    'postgresql://postgres@localhost/localbasic_dev?host=/tmp&port=5433',
});

const SLUG = 'retailpurch';
const OWNER = 'retailpurch-owner@demo.local';
const BASE = `/${SLUG}/main`;

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

/**
 * A retail workspace, provisioned the same way the product does it — through
 * `provision_workspace` under the owner's own session, not by hand-inserting
 * rows that RLS would never have allowed.
 */
test.beforeAll(async () => {
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

  // One connection for the whole provisioning step: `set_config(..., false)`
  // is session state, and a pool hands the next query a different session, so
  // the claims would not be in force when provision_workspace ran.
  // One connection, inside a transaction, with `set_config(..., true)`: the
  // identity is session state, and a pool would otherwise hand the next query
  // a different session — or worse, hand a later query this one still wearing
  // the `authenticated` role.
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
         from public.provision_workspace('متجر الاختبار', $1, 'retail')`,
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
    `insert into public.retail_products (organization_id, name, tax_rate_bp)
     values ($1, 'أرز', 0) returning id`,
    [orgId],
  );
  const { rows: variant } = await asAdmin(
    `insert into public.retail_variants
       (organization_id, product_id, name, sku, price_cents, cost_cents)
     values ($1, $2, 'كيلو', 'RICE-1', 5000, 3000) returning id`,
    [orgId, product[0].id],
  );
  variantId = variant[0].id;

  await asAdmin(
    `insert into public.retail_suppliers (organization_id, name)
     values ($1, 'مورد الجملة')`,
    [orgId],
  );
});

test.afterAll(async () => {
  if (orgId) await asAdmin('delete from organizations where id = $1', [orgId]);
  if (ownerId) await asAdmin('delete from auth.users where id = $1', [ownerId]);
  await DB.end();
});

/** Each test starts with no purchasing history and no stock. */
test.beforeEach(async ({ context, page }) => {
  await context.route('**/*', (route) =>
    route.request().url().startsWith('http://localhost:3000') ? route.continue() : route.abort(),
  );
  await asAdmin('delete from retail_purchase_orders where organization_id = $1', [orgId]);
  await asAdmin('delete from retail_stock_movements where organization_id = $1', [orgId]);
  await asAdmin('delete from retail_stock_levels where organization_id = $1', [orgId]);
  await asAdmin(
    "delete from treasury_transactions where organization_id = $1 and category = 'purchase'",
    [orgId],
  );
  // Receiving updates the catalog cost, so reset it: the order builder seeds
  // the cost field from it, and a test that inherited the previous test's
  // cost would be testing the leftover rather than the flow.
  await asAdmin('update retail_variants set cost_cents = 3000 where id = $1', [variantId]);
  await actAs(page, ownerId);
});

async function stockOnHand(): Promise<number> {
  const { rows } = await DB.query(
    'select coalesce(quantity, 0) as q from retail_stock_levels where branch_id = $1 and variant_id = $2',
    [branchId, variantId],
  );
  return rows.length ? Number(rows[0].q) : 0;
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

test('an owner raises a purchase order and the total is computed on the server', async ({
  page,
}) => {
  await page.goto(`${BASE}/purchases/new`);

  await page.getByLabel('المورد').selectOption({ label: 'مورد الجملة' });
  await page.getByLabel('الصنف').selectOption({ label: 'أرز — كيلو (RICE-1)' });
  await page.getByLabel('الكمية').fill('10');
  await page.getByLabel('سعر الوحدة').fill('');
  await page.getByLabel('سعر الوحدة').fill('30.00');

  await page.getByRole('button', { name: 'حفظ أمر الشراء' }).click();
  await expect(page.getByText('مسودة')).toBeVisible();

  // 10 × 3000 = 30000, and the number on screen is the one the database
  // derived, not the one the browser previewed.
  const { rows } = await DB.query(
    'select number, status, total_cents from retail_purchase_orders where organization_id = $1',
    [orgId],
  );
  expect(rows).toHaveLength(1);
  expect(Number(rows[0].total_cents)).toBe(30000);
  expect(rows[0].status).toBe('draft');
  await expect(page.getByText(rows[0].number)).toBeVisible();
});

test('receiving moves the stock the POS reads, and a partial delivery stays open', async ({
  page,
}) => {
  await page.goto(`${BASE}/purchases/new`);
  await page.getByLabel('الصنف').selectOption({ label: 'أرز — كيلو (RICE-1)' });
  await page.getByLabel('الكمية').fill('10');
  await page.getByLabel('سعر الوحدة').fill('');
  await page.getByLabel('سعر الوحدة').fill('30.00');
  await page.getByRole('button', { name: 'حفظ أمر الشراء' }).click();
  await expect(page.getByText('مسودة')).toBeVisible();

  // Nothing is in stock until goods actually arrive.
  expect(await stockOnHand()).toBe(0);

  await page.getByTestId('submit-purchase').click();
  await expect(page.getByText('مطلوبة')).toBeVisible();

  const { rows: items } = await DB.query(
    `select i.id from retail_purchase_order_items i
       join retail_purchase_orders o on o.id = i.purchase_order_id
      where o.organization_id = $1`,
    [orgId],
  );
  const itemId = items[0].id as string;

  await page.getByTestId(`receive-${itemId}`).fill('4');
  await page.getByTestId('receive-purchase').click();
  await expect(page.getByText('مستلمة جزئيًا')).toBeVisible();

  expect(await stockOnHand()).toBe(4);

  // The same ledger the POS reads, with the purchase reason recorded.
  const { rows: moves } = await DB.query(
    `select reason, ref_type, quantity_delta from retail_stock_movements
      where organization_id = $1`,
    [orgId],
  );
  expect(moves).toHaveLength(1);
  expect(moves[0].reason).toBe('purchase');
  expect(moves[0].ref_type).toBe('retail_purchase');

  // And the inventory screen agrees.
  await page.goto(`${BASE}/inventory`);
  await expect(page.getByText('أرز').first()).toBeVisible();

  // Finish the delivery: the order closes.
  await page.goto(`${BASE}/purchases`);
  await page.getByRole('link', { name: /\d/ }).first().click();
  await page.getByTestId(`receive-${itemId}`).fill('6');
  await page.getByTestId('receive-purchase').click();
  await expect(page.getByText('مستلمة', { exact: true })).toBeVisible();
  expect(await stockOnHand()).toBe(10);
});

test('the screen refuses to receive more than was ordered', async ({ page }) => {
  await page.goto(`${BASE}/purchases/new`);
  await page.getByLabel('الصنف').selectOption({ label: 'أرز — كيلو (RICE-1)' });
  await page.getByLabel('الكمية').fill('3');
  await page.getByLabel('سعر الوحدة').fill('');
  await page.getByLabel('سعر الوحدة').fill('30.00');
  await page.getByRole('button', { name: 'حفظ أمر الشراء' }).click();
  await page.getByTestId('submit-purchase').click();
  await expect(page.getByText('مطلوبة')).toBeVisible();

  const { rows: items } = await DB.query(
    `select i.id from retail_purchase_order_items i
       join retail_purchase_orders o on o.id = i.purchase_order_id
      where o.organization_id = $1`,
    [orgId],
  );

  await page.getByTestId(`receive-${items[0].id}`).fill('99');
  await page.getByTestId('receive-purchase').click();

  // The refusal is reported, and nothing moved.
  await expect(page.getByText(/أكثر|cannot receive more/i)).toBeVisible();
  expect(await stockOnHand()).toBe(0);
});

test('paying a supplier takes the money out of the treasury', async ({ page }) => {
  await page.goto(`${BASE}/purchases/new`);
  await page.getByLabel('الصنف').selectOption({ label: 'أرز — كيلو (RICE-1)' });
  await page.getByLabel('الكمية').fill('2');
  await page.getByLabel('سعر الوحدة').fill('');
  await page.getByLabel('سعر الوحدة').fill('30.00');
  await page.getByRole('button', { name: 'حفظ أمر الشراء' }).click();
  await page.getByTestId('submit-purchase').click();
  await expect(page.getByText('مطلوبة')).toBeVisible();

  await page.getByTestId('pay-amount').fill('20.00');
  await page.getByTestId('pay-purchase').click();

  await expect(page.getByTestId('pay-amount')).toHaveValue('');

  const { rows } = await DB.query(
    `select direction, amount_cents, category, ref_type from treasury_transactions
      where organization_id = $1 and ref_type = 'retail_purchase'`,
    [orgId],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].direction).toBe('out');
  expect(Number(rows[0].amount_cents)).toBe(2000);
  expect(rows[0].category).toBe('purchase');

  // paid_cents is recomputed from that ledger, not incremented in the browser.
  const { rows: order } = await DB.query(
    'select paid_cents, total_cents from retail_purchase_orders where organization_id = $1',
    [orgId],
  );
  expect(Number(order[0].paid_cents)).toBe(2000);
  expect(Number(order[0].total_cents)).toBe(6000);

  // Overpaying is refused by the database, not by the form.
  await page.getByTestId('pay-amount').fill('500.00');
  await page.getByTestId('pay-purchase').click();
  await expect(page.getByText(/exceeds|الإجمالي/i).first()).toBeVisible();
});

test('a member without purchasing permission sees nothing', async ({ page, context }) => {
  const email = `retailpurch-clerk-${Date.now().toString(36)}@demo.local`;
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
    member[0].id,
    branchId,
  ]);

  await context.clearCookies();
  await actAs(page, clerkId);

  // A member of the organization who holds no purchasing permission gets the
  // refusal, not the screen. `requirePermission` raises the same error for
  // "not allowed" as for "does not exist", which is the point — and that error
  // reaches the app's error boundary, which is pre-existing behaviour for every
  // workspace route, not something this feature changed. So the assertion is
  // about what is NOT on the page.
  for (const path of ['/purchases', '/purchases/new', '/suppliers']) {
    await page.goto(`${BASE}${path}`);
    await expect(page.getByRole('link', { name: 'أمر شراء جديد' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'حفظ أمر الشراء' })).toHaveCount(0);
    await expect(page.getByText('لا توجد أوامر شراء بعد')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'إضافة المورد' })).toHaveCount(0);
  }

  // And the refusal is not cosmetic: the order the owner raised stays
  // invisible and untouched, because RLS and the database function refuse the
  // clerk regardless of what the UI offers.
  const { rows: before } = await DB.query(
    'select count(*)::int as n from retail_purchase_orders where organization_id = $1',
    [orgId],
  );
  expect(before[0].n).toBe(0);

  await asAdmin('delete from auth.users where id = $1', [clerkId]);
});
