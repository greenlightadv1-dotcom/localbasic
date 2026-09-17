import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * Retail analytics.
 *
 * The one thing a report must never do is invent a number, so every assertion
 * here compares what the screen shows against what the underlying ledger
 * actually holds — and the figures are produced by really selling, really
 * buying and really receiving, not by writing rows that look like it.
 */
const DB = new Pool({
  connectionString:
    process.env.LOCAL_DATABASE_URL ??
    'postgresql://postgres@localhost/localbasic_dev?host=/tmp&port=5433',
});

const SLUG = 'retailrep';
const OWNER = 'retailrep-owner@demo.local';
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
 * Arabic-Indic digits and the Arabic decimal separator both render in an RTL
 * locale, which is correct. Normalise to Latin so a test can read the number
 * rather than assert around the formatting.
 */
function toLatinDigits(text: string): string {
  return text
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u066b]/g, '.')
    .replace(/[\u066c]/g, '')
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
         from public.provision_workspace('متجر التقارير', $1, 'retail')`,
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
     values ($1, 'سكر', 0, true) returning id`,
    [orgId],
  );
  const { rows: variant } = await asAdmin(
    `insert into public.retail_variants
       (organization_id, product_id, name, sku, price_cents, cost_cents, reorder_point)
     values ($1, $2, 'كيلو', 'SUGAR-1', 5000, 3000, 5) returning id`,
    [orgId, product[0].id],
  );
  variantId = variant[0].id;
});

test.afterAll(async () => {
  if (orgId) await asAdmin('delete from organizations where id = $1', [orgId]);
  if (ownerId) await asAdmin('delete from auth.users where id = $1', [ownerId]);
  await DB.end();
});

test.beforeEach(async ({ context, page }) => {
  await context.route('**/*', (route) =>
    route.request().url().startsWith('http://localhost:3000') ? route.continue() : route.abort(),
  );
  await asAdmin('delete from treasury_transactions where organization_id = $1', [orgId]);
  await asAdmin('delete from payments where organization_id = $1', [orgId]);
  await asAdmin('delete from invoice_items where organization_id = $1', [orgId]);
  await asAdmin('delete from invoices where organization_id = $1', [orgId]);
  await asAdmin('delete from retail_purchase_orders where organization_id = $1', [orgId]);
  await asAdmin('delete from retail_stock_movements where organization_id = $1', [orgId]);
  await asAdmin('delete from retail_stock_levels where organization_id = $1', [orgId]);
  await actAs(page, ownerId);
});

/** Runs a database function as the owner, in one session, the way the app does. */
async function asOwner(sql: string, params: unknown[] = []) {
  const client = await DB.connect();
  try {
    await client.query('begin');
    await client.query(
      `select set_config('request.jwt.claims',
         json_build_object('sub', $1::text, 'role', 'authenticated')::text, true),
              set_config('role', 'authenticated', true)`,
      [ownerId],
    );
    const result = await client.query(sql, params);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

test('the report is empty when nothing has happened', async ({ page }) => {
  await page.goto(`${BASE}/reports`);
  await expect(page.getByRole('heading', { name: 'التقارير' })).toBeVisible();
  // The retail report, not the restaurant one.
  await expect(page.getByText('تكلفة البضاعة المباعة')).toBeVisible();
  await expect(page.getByText('لا توجد مدفوعات في هذه الفترة')).toBeVisible();
});

test('a real sale is reported exactly as the ledgers hold it', async ({ page }) => {
  // Stock in, through purchasing, so the cost on the movement is real.
  const { rows: po } = await asOwner(
    `select out_id from public.retail_purchase_create($1, $2, null,
       jsonb_build_array(jsonb_build_object(
         'variant_id', $3::text, 'quantity', 10, 'unit_cost_cents', 3000)))`,
    [orgId, branchId, variantId],
  );
  await asOwner('select public.retail_purchase_submit($1, $2, $3)', [orgId, branchId, po[0].out_id]);
  const { rows: item } = await asAdmin(
    'select id from retail_purchase_order_items where purchase_order_id = $1',
    [po[0].out_id],
  );
  await asOwner(
    `select public.retail_purchase_receive($1, $2, $3,
       jsonb_build_array(jsonb_build_object('item_id', $4::text, 'quantity', 10)))`,
    [orgId, branchId, po[0].out_id, item[0].id],
  );

  // Two sold at the till, at 50.00 each.
  await asOwner(
    `select public.retail_create_sale($1, $2,
       jsonb_build_array(jsonb_build_object('variant_id', $3::text, 'quantity', 2)),
       'cash', 10000)`,
    [orgId, branchId, variantId],
  );

  await page.goto(`${BASE}/reports`);

  // Revenue is what the payments ledger says, not what the order said.
  const { rows: payments } = await DB.query(
    `select coalesce(sum(amount_cents), 0)::bigint as total
       from payments where organization_id = $1 and status = 'completed'`,
    [orgId],
  );
  expect(Number(payments[0].total)).toBe(10000);

  const body = toLatinDigits(await page.locator('body').innerText());
  expect(body).toContain('100.00');   // revenue, 2 × 50.00
  expect(body).toContain('60.00');    // cost of goods, 2 × 30.00 from the movement
  expect(body).toContain('40.00');    // gross profit

  // Units moved, from the one ledger.
  await expect(page.getByText('وحدات بيعت')).toBeVisible();
  await expect(page.getByText('وحدات استُلمت')).toBeVisible();

  const { rows: sold } = await DB.query(
    `select coalesce(sum(-quantity_delta), 0)::numeric as q
       from retail_stock_movements
      where organization_id = $1 and reason = 'sale'`,
    [orgId],
  );
  expect(Number(sold[0].q)).toBe(2);

  // Purchasing is reported too, from its own documents. Scoped to the card,
  // because the sidebar link carries the same word.
  const purchasingCard = page.locator('section, div').filter({ hasText: 'أوامر شراء' }).last();
  await expect(purchasingCard).toBeVisible();
  await expect(page.getByText('قيمة ملتزم بها')).toBeVisible();
});

test('low stock is a live figure, not a range one', async ({ page }) => {
  // Reorder point is 5; put four on the shelf.
  await asAdmin(
    `insert into retail_stock_movements
       (organization_id, branch_id, variant_id, quantity_delta, reason)
     values ($1, $2, $3, 4, 'initial')`,
    [orgId, branchId, variantId],
  );

  await page.goto(`${BASE}/reports`);
  await expect(page.getByText('أصناف تحتاج إعادة طلب')).toBeVisible();
  await expect(page.getByRole('cell', { name: /سكر/ })).toBeVisible();

  // Above the reorder point, it drops off the list.
  await asAdmin(
    `insert into retail_stock_movements
       (organization_id, branch_id, variant_id, quantity_delta, reason)
     values ($1, $2, $3, 10, 'adjustment')`,
    [orgId, branchId, variantId],
  );
  await page.reload();
  await expect(page.getByText('لا توجد أصناف تحت حد إعادة الطلب')).toBeVisible();
});

test('a member without money permissions sees no money', async ({ page, context }) => {
  const email = `retailrep-clerk-${Date.now().toString(36)}@demo.local`;
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
  const { rows: role } = await asAdmin(
    `insert into public.roles (organization_id, key, name_ar, name_en)
     values ($1, 'repclerk', 'موظف تقارير', 'Report clerk') returning id`,
    [orgId],
  );
  // Reports, and inventory — but nothing financial.
  for (const key of ['report.read', 'retail.inventory.read']) {
    await asAdmin(
      'insert into public.role_permissions (role_id, permission_key) values ($1, $2)',
      [role[0].id, key],
    );
  }
  await asAdmin('insert into public.user_roles (member_id, role_id) values ($1, $2)', [
    member[0].id, role[0].id,
  ]);

  // Sell something, so there IS money to hide.
  await asAdmin(
    `insert into retail_stock_movements
       (organization_id, branch_id, variant_id, quantity_delta, reason)
     values ($1, $2, $3, 10, 'initial')`,
    [orgId, branchId, variantId],
  );
  await asOwner(
    `select public.retail_create_sale($1, $2,
       jsonb_build_array(jsonb_build_object('variant_id', $3::text, 'quantity', 2)),
       'cash', 10000)`,
    [orgId, branchId, variantId],
  );

  await context.clearCookies();
  await actAs(page, clerkId);
  await page.goto(`${BASE}/reports`);

  // The inventory section is theirs to see.
  await expect(page.getByText('وحدات بيعت')).toBeVisible();

  // The money is not: the payment section was never computed, so the figure
  // shows zero rather than the real revenue.
  await expect(page.getByText('لا توجد مدفوعات في هذه الفترة')).toBeVisible();
  const body = toLatinDigits(await page.locator('body').innerText());
  expect(body).not.toContain('100.00');

  await asAdmin('delete from auth.users where id = $1', [clerkId]);
});
