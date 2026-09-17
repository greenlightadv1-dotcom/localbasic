import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * Drives the real screens through the service journey, so the interactive
 * paths are proven rather than assumed.
 *
 * Each test seeds the order it needs through the same database functions the
 * application calls, so the suite is repeatable and order-independent — the
 * earlier version leaned on the demo seed and only passed once.
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

/** Runs SQL as a given staff member, exactly as the app's session would. */
async function asUser(
  email: string,
  fn: (q: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, string>[] }>) => Promise<void>,
) {
  const id = await userId(email);
  const client = await DB.connect();
  try {
    await client.query('begin');
    await client.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify({ sub: id, role: 'authenticated' }),
    ]);
    await client.query("select set_config('role', 'authenticated', true)");
    await fn(async (sql, params) => ({ rows: (await client.query(sql, params)).rows }));
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function ids() {
  const { rows } = await DB.query(`
    select o.id as org, b.id as branch,
      (select v.id from restaurant_variants v
         join restaurant_products p on p.id = v.product_id
        where p.name = 'شيش طاووق' limit 1) as variant
    from organizations o join branches b on b.organization_id = o.id
    where o.slug = 'alhara' and b.slug = 'main'`);
  return rows[0] as { org: string; branch: string; variant: string };
}

/** Creates a fresh order at the given status, and returns its number. */
async function seedOrder(status: 'new' | 'confirmed' | 'preparing' | 'ready') {
  const { org, branch, variant } = await ids();
  let number = '';

  await asUser('cashier@demo.local', async (q) => {
    const { rows } = await q(
      `select * from restaurant_create_order($1, $2, $3::jsonb, null, 'takeaway')`,
      [org, branch, JSON.stringify([{ variant_id: variant, quantity: 1 }])],
    );
    const order = rows[0]!;
    number = order.out_number!;
    if (status !== 'new') {
      await q(`select restaurant_set_order_status($1, $2, 'confirmed')`, [org, order.out_order_id]);
    }
  });

  if (status === 'preparing' || status === 'ready') {
    const { rows } = await DB.query(
      'select id from restaurant_orders where number = $1 and organization_id = $2',
      [number, org],
    );
    await asUser('kitchen@demo.local', async (q) => {
      await q(`select restaurant_set_order_status($1, $2, 'preparing')`, [org, rows[0].id]);
      if (status === 'ready') {
        await q(`select restaurant_set_order_status($1, $2, 'ready')`, [org, rows[0].id]);
      }
    });
  }

  return number;
}

async function actAs(page: Page, email: string) {
  const id = await userId(email);
  await page.context().addCookies([
    { name: 'lb_local_user', value: id, url: 'http://localhost:3000' },
  ]);
}

// This sandbox has no egress; a stalled webfont request would hold every
// navigation open until the test times out.
test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) =>
    route.request().url().startsWith('http://localhost:3000') ? route.continue() : route.abort(),
  );
});

test.afterAll(async () => {
  await DB.end();
});

test('a guest orders from a table QR', async ({ page }) => {
  const { rows } = await DB.query(
    `select pl.token from public_links pl
     join restaurant_tables t on t.public_link_id = pl.id
     where t.name = '6' and pl.is_active limit 1`,
  );

  await page.goto(`/p/${rows[0].token}`);
  await expect(page.getByRole('heading', { name: 'مطعم الحارة الشامية' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'المشاوي' })).toBeVisible();

  await page.getByRole('button', { name: /دجاج/ }).first().click();
  await page.getByRole('button', { name: 'إضافة للطلب' }).click();
  await page.getByRole('button', { name: /عرض الطلب/ }).click();
  await page.getByRole('button', { name: 'إرسال الطلب' }).click();

  await expect(page.getByRole('heading', { name: 'تم استلام طلبك' })).toBeVisible({
    timeout: 20_000,
  });
});

test('the kitchen marks an order ready and the waiter serves it', async ({ page }) => {
  const number = await seedOrder('preparing');

  await actAs(page, 'kitchen@demo.local');
  await page.goto('/alhara/main/kitchen');

  const ticket = page.locator('li').filter({ hasText: `#${number}` });
  await expect(ticket).toBeVisible();
  await ticket.getByRole('button', { name: 'جاهز' }).click();
  await expect(page.getByText('الطلب جاهز للتقديم')).toBeVisible({ timeout: 20_000 });

  await actAs(page, 'waiter@demo.local');
  await page.goto('/alhara/main/service');
  const row = page.locator('li').filter({ hasText: `#${number}` });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'تم التقديم' }).click();
  await expect(page.getByText('تم تسجيل التقديم')).toBeVisible({ timeout: 20_000 });
});

test('the cashier confirms an order and takes payment', async ({ page }) => {
  const number = await seedOrder('new');

  await actAs(page, 'cashier@demo.local');
  await page.goto('/alhara/main/cashier');

  const row = page.locator('li').filter({ hasText: `#${number}` });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'تأكيد' }).click();
  await expect(page.getByText('تم تأكيد الطلب وإرساله للمطبخ')).toBeVisible({ timeout: 20_000 });

  const again = page.locator('li').filter({ hasText: `#${number}` });
  await again.getByRole('button', { name: 'تحصيل' }).click();
  await expect(page.getByRole('heading', { name: /تحصيل الطلب/ })).toBeVisible();
  await page.getByRole('button', { name: 'تأكيد التحصيل' }).click();
  await expect(page.getByRole('heading', { name: /^إيصال/ })).toBeVisible({ timeout: 20_000 });
});

test('the kitchen cannot reach the money screens', async ({ page }) => {
  await actAs(page, 'kitchen@demo.local');

  for (const path of ['/treasury', '/reports', '/cashier', '/invoices', '/expenses']) {
    await page.goto(`/alhara/main${path}`);
    await expect(page.getByRole('heading', { name: 'الصفحة غير موجودة' })).toBeVisible();
  }

  // The links are not offered either.
  await page.goto('/alhara/main/kitchen');
  await expect(page.getByRole('link', { name: 'الخزينة' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'التقارير' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'الإيصالات' })).toHaveCount(0);
});

/**
 * The newest order must survive the list cap.
 *
 * `listOrders` caps its result. Asking the database for oldest-first and then
 * capping discards the NEWEST rows, so a branch busy enough to exceed the cap
 * stops seeing the orders it just took. This pins the fix: with a backlog well
 * past the limit, the order placed last is still on the cashier's screen.
 */
test('a new order is visible even behind a large backlog', async ({ page }) => {
  const { org, branch } = await ids();

  const { rows: before } = await DB.query(
    `select count(*)::int as n from restaurant_orders
      where organization_id = $1 and branch_id = $2
        and status in ('new','confirmed','preparing','ready','served')`,
    [org, branch],
  );

  // Enough open orders to push past the 100-row cap. Inserted directly: this
  // is about what the list renders, not about how an order is created.
  const needed = Math.max(0, 110 - before[0].n);
  for (let i = 0; i < needed; i += 1) {
    await DB.query(
      `insert into restaurant_orders
         (organization_id, branch_id, number, status, channel, type, currency, placed_at)
       values ($1, $2, $3, 'new', 'cashier', 'takeaway', 'EGP', now() - interval '1 day')`,
      [org, branch, `BACKLOG-${Date.now()}-${i}`],
    );
  }

  // Placed last, so oldest-first + cap would have hidden it.
  const number = await seedOrder('confirmed');

  await actAs(page, 'cashier@demo.local');
  await page.goto('/alhara/main/cashier');
  await expect(page.locator('li').filter({ hasText: `#${number}` })).toBeVisible();

  await DB.query('delete from restaurant_orders where number like $1', ['BACKLOG-%']);
});
