import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * The Platform Admin console: search, the customer profile, and the dashboard.
 *
 * The SQL suite proves the database refuses non-admins and scopes every
 * projection. This proves the operator's screens show real, matching numbers —
 * and that the console leaks neither internal identifiers nor credentials into
 * the page a browser receives.
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

async function demoOrg() {
  const { rows } = await DB.query(
    "select id, customer_code from organizations where slug = 'alhara'",
  );
  return { id: rows[0].id as string, code: rows[0].customer_code as string };
}

test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) =>
    route.request().url().startsWith('http://localhost:3000') ? route.continue() : route.abort(),
  );
});

test.afterAll(async () => { await DB.end(); });

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

test('the dashboard counts match the database', async ({ page }) => {
  await actAs(page, await platformAdminId());
  await page.goto('/admin');

  // Not "a number is rendered" — the number rendered is the number of rows.
  const { rows } = await DB.query(
    'select count(*)::int as n from organizations where deleted_at is null',
  );
  const total = String(Number(rows[0].n).toLocaleString('ar-EG'));

  const card = page.locator('div', { hasText: /^إجمالي العملاء/ }).last();
  await expect(card).toContainText(total);

  const branchCount = await DB.query(`
    select count(*)::int as n from branches b
    join organizations o on o.id = b.organization_id
    where b.deleted_at is null and o.deleted_at is null`);
  await expect(
    page.locator('div', { hasText: /^إجمالي الفروع/ }).last(),
  ).toContainText(String(Number(branchCount.rows[0].n).toLocaleString('ar-EG')));

  await expect(page.getByText('آخر نشاط على المنصة')).toBeVisible();
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

async function search(page: Page, term: string) {
  await page.goto(`/admin/customers?q=${encodeURIComponent(term)}`);
}

test('search finds a customer by owner email, phone and name', async ({ page }) => {
  await actAs(page, await platformAdminId());
  const { id } = await demoOrg();

  // Give the demo restaurant a published contact number to search on.
  await DB.query(
    `insert into branding_settings (organization_id, phone)
     values ($1, '0223334444')
     on conflict (organization_id) do update set phone = excluded.phone`,
    [id],
  );

  for (const term of ['owner@demo.local', '0223334444', 'الحارة']) {
    await search(page, term);
    await expect(
      page.getByRole('link', { name: 'مطعم الحارة الشامية' }),
      `searching "${term}" should find the demo restaurant`,
    ).toBeVisible();
  }

  // And the row carries what an operator needs to confirm they have the right
  // customer on the line.
  await expect(page.getByText('owner@demo.local')).toBeVisible();
});

test('a search term cannot steer the query', async ({ page }) => {
  await actAs(page, await platformAdminId());

  // Terms that would have broken out of the old interpolated PostgREST filter,
  // plus a bare wildcard. Each is a search that finds nothing.
  for (const term of ['%', '_', 'x,status.eq.active', "x'; drop table organizations; --"]) {
    await search(page, term);
    await expect(
      page.getByText(`لا نتائج لـ «${term}»`),
      `"${term}" should match nothing`,
    ).toBeVisible();
  }

  // The schema survived.
  const { rows } = await DB.query(
    "select to_regclass('public.organizations') is not null as ok",
  );
  expect(rows[0].ok).toBe(true);
});

// ---------------------------------------------------------------------------
// Customer profile
// ---------------------------------------------------------------------------

test('the customer profile shows the operational picture', async ({ page }) => {
  await actAs(page, await platformAdminId());
  const { code } = await demoOrg();

  await page.goto(`/admin/customers/${code}`);

  for (const section of [
    'بيانات العميل', 'المالك', 'الخدمات', 'الموقع والطلبات',
    'الفروع', 'الاشتراك الحالي', 'تجديد الاشتراك', 'سجل الاشتراكات', 'النشاط',
  ]) {
    await expect(page.getByRole('heading', { name: new RegExp(section) })).toBeVisible();
  }

  // The owner's real address, read through the admin-gated function.
  await expect(page.getByText('owner@demo.local')).toBeVisible();
  // The restaurant's real branch, by name.
  const { rows } = await DB.query(
    `select b.name from branches b join organizations o on o.id = b.organization_id
      where o.slug = 'alhara' and b.deleted_at is null order by b.created_at limit 1`,
  );
  await expect(page.getByText(rows[0].name as string).first()).toBeVisible();
});

test('the profile exposes no internal identifiers and no credentials', async ({ page }) => {
  await actAs(page, await platformAdminId());
  const { id, code } = await demoOrg();

  await page.goto(`/admin/customers/${code}`);
  const html = await page.content();

  // The address bar carries the customer code, never a UUID.
  expect(page.url()).not.toContain(id);

  // The organization id is a form value for the renewal action and nothing
  // else: it must never be rendered as something a person reads.
  await expect(page.getByText(id)).toHaveCount(0);
  const asFormValue = await page
    .locator(`input[type="hidden"][value="${id}"], [name="organizationId"][value="${id}"]`)
    .count();
  expect(asFormValue, 'the organization id should only be a renewal form field')
    .toBeGreaterThan(0);

  // No branch ids at all: the console displays branches, it never acts on one.
  const { rows: branches } = await DB.query(
    `select b.id from branches b join organizations o on o.id = b.organization_id
      where o.slug = 'alhara'`,
  );
  for (const b of branches) {
    expect(html).not.toContain(b.id as string);
  }

  // And nothing that looks like a key reached the browser.
  expect(html).not.toContain('service_role');
  expect(html).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
});

test('a tenant owner sees nothing on the new console screens', async ({ page }) => {
  await actAs(page, await userId('owner@demo.local'));
  const { code, id } = await demoOrg();

  for (const path of ['/admin', '/admin/customers', `/admin/customers/${code}`]) {
    await page.goto(path);
    await expect(page.getByText('الصفحة غير موجودة')).toBeVisible();
    const body = await page.locator('body').innerText();
    expect(body).not.toContain(code);
    expect(body).not.toContain('owner@demo.local');
    expect(body).not.toContain(id);
  }
});

// ---------------------------------------------------------------------------
// The renamed route
// ---------------------------------------------------------------------------

test('the old /admin/organizations paths still resolve', async ({ page }) => {
  await actAs(page, await platformAdminId());
  const { code } = await demoOrg();

  await page.goto('/admin/organizations?q=alhara');
  await expect(page).toHaveURL(/\/admin\/customers\?q=alhara$/);
  await expect(page.getByRole('link', { name: 'مطعم الحارة الشامية' })).toBeVisible();

  await page.goto(`/admin/organizations/${code}`);
  await expect(page).toHaveURL(new RegExp(`/admin/customers/${code}$`));
});
