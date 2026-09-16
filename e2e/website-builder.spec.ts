import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * The website builder, driven through the real screens.
 *
 * The SQL suite proves the database refuses cross-tenant writes and unsafe
 * content. This proves the flow an owner actually walks: build a draft,
 * preview it, confirm the public site has NOT moved, publish, and confirm it
 * has — with ordering and the default-layout fallback both still intact.
 */
const DB = new Pool({
  connectionString:
    process.env.LOCAL_DATABASE_URL ??
    'postgresql://postgres@localhost/localbasic_dev?host=/tmp&port=5433',
});

const ORG = 'alhara';
const BUILDER = `/${ORG}/main/settings/website/builder`;

async function orgId() {
  const { rows } = await DB.query('select id from organizations where slug = $1', [ORG]);
  return rows[0].id as string;
}

async function actAs(page: Page, email: string) {
  const { rows } = await DB.query('select id from auth.users where email = $1', [email]);
  await page.context().addCookies([
    { name: 'lb_local_user', value: rows[0].id, url: 'http://localhost:3000' },
  ]);
}

/** Wipes the builder's state so each test starts from the default layout. */
async function resetWebsite() {
  const id = await orgId();
  await DB.query('delete from restaurant_website_sections where organization_id = $1', [id]);
  await DB.query('delete from restaurant_website_revisions where organization_id = $1', [id]);
  await DB.query(
    "delete from settings where organization_id = $1 and key = 'restaurant.website_theme'",
    [id],
  );
  for (const key of [
    'restaurant.website_enabled',
    'restaurant.online_ordering_enabled',
    'restaurant.pickup_enabled',
  ]) {
    await DB.query(
      `insert into settings (organization_id, branch_id, key, value)
       values ($1, null, $2, 'true'::jsonb)
       on conflict (organization_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), key)
       do update set value = excluded.value`,
      [id, key],
    );
  }
  // Branch-scoped overrides would mask the organization defaults set above.
  await DB.query(
    `delete from settings where organization_id = $1 and branch_id is not null
      and key in ('restaurant.online_ordering_enabled', 'restaurant.pickup_enabled')`,
    [id],
  );
}

test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) =>
    route.request().url().startsWith('http://localhost:3000') ? route.continue() : route.abort(),
  );
  await resetWebsite();
});

test.afterAll(async () => {
  await resetWebsite();
  await DB.end();
});

// ---------------------------------------------------------------------------
// Backward compatibility — the whole point of the fallback
// ---------------------------------------------------------------------------

test('a restaurant that never opens the builder renders exactly as before', async ({ page }) => {
  await page.goto(`/r/${ORG}`);

  // The D2 page: name, menu, branches, and the ordering CTA.
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('#menu')).toBeVisible();
  await expect(page.getByRole('link', { name: /اطلب/ }).first()).toBeVisible();

  const { rows } = await DB.query(
    `select p.name from restaurant_products p
     join organizations o on o.id = p.organization_id
     where o.slug = $1 and p.is_active and p.deleted_at is null limit 1`,
    [ORG],
  );
  await expect(page.getByText(rows[0].name as string).first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

test('a member without settings.manage cannot open the builder', async ({ page }) => {
  await actAs(page, 'kitchen@demo.local');
  await page.goto(BUILDER);
  await expect(page.getByText('الصفحة غير موجودة')).toBeVisible();

  await page.goto(`${BUILDER}/preview`);
  await expect(page.getByText('الصفحة غير موجودة')).toBeVisible();
});

test('an anonymous visitor gets no builder and no tenant data', async ({ page }) => {
  await page.context().clearCookies();

  for (const path of [BUILDER, `${BUILDER}/preview`]) {
    await page.goto(path);
    const body = await page.locator('body').innerText();

    // Every workspace route answers an anonymous caller with the app's generic
    // error boundary rather than a sign-in redirect — pre-existing behaviour,
    // identical on /orders and the older settings screens. What matters here is
    // that nothing of the restaurant's reaches the page.
    await expect(page.getByRole('heading', { name: 'محرّر الموقع' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /نشر/ })).toHaveCount(0);
    expect(body).not.toContain('مطعم الحارة الشامية');
  }
});

test('another tenant cannot reach this builder', async ({ page }) => {
  // A real owner of a DIFFERENT organization, provisioned for this test.
  const email = `wb-other-${Date.now().toString(36)}@demo.local`;
  const slug = `wbother${Date.now().toString().slice(-6)}`;
  const { rows } = await DB.query(
    'insert into auth.users (email) values ($1) returning id',
    [email],
  );
  await DB.query(
    `insert into public.profiles (id, full_name) values ($1, 'مالك آخر')
     on conflict (id) do nothing`,
    [rows[0].id],
  );
  await DB.query(
    `select set_config('request.jwt.claims',
       json_build_object('sub', $1::text, 'role', 'authenticated')::text, false),
            set_config('role', 'authenticated', false)`,
    [rows[0].id],
  );
  await DB.query('select public.provision_workspace($1, $2, $3)', ['مطعم آخر', slug, 'restaurant']);
  await DB.query("select set_config('role', 'postgres', false)");

  await actAs(page, email);
  // Their own builder works; this one does not exist for them.
  await page.goto(BUILDER);
  await expect(page.getByText('الصفحة غير موجودة')).toBeVisible();
});

// ---------------------------------------------------------------------------
// The full flow
// ---------------------------------------------------------------------------

test('an owner builds a draft, previews it, and publishes it', async ({ page }) => {
  await actAs(page, 'owner@demo.local');
  await page.goto(BUILDER);
  await expect(page.getByRole('heading', { name: 'محرّر الموقع' })).toBeVisible();
  await expect(page.getByText('لم يُنشر تصميم مخصّص')).toBeVisible();

  // Add a hero and edit its content.
  await page.getByLabel('أضف قسمًا').selectOption('hero');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await expect(page.getByText('تم الحفظ في المسودة.')).toBeVisible();

  await page.getByRole('textbox', { name: 'العنوان' }).first().fill('أهلاً في الحارة');
  await page.getByRole('button', { name: 'حفظ القسم' }).first().click();
  await expect(page.getByText('تم الحفظ في المسودة.')).toBeVisible();

  // Add a CTA below it.
  await page.getByLabel('أضف قسمًا').selectOption('cta');
  await page.getByRole('button', { name: 'إضافة' }).click();

  // The draft is visible in the preview...
  await page.goto(`${BUILDER}/preview`);
  await expect(page.getByText('معاينة المسودة — لا يراها الزوار')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'أهلاً في الحارة' })).toBeVisible();

  // ...and NOT on the public site, which is still on the default layout.
  await page.goto(`/r/${ORG}`);
  await expect(page.getByText('أهلاً في الحارة')).toHaveCount(0);
  await expect(page.locator('#menu')).toBeVisible();

  // Publish.
  await page.goto(BUILDER);
  await page.getByRole('button', { name: /نشر الموقع/ }).click();
  await expect(page.getByTestId('published-ok')).toBeVisible();

  // Now the public site shows the new layout.
  await page.goto(`/r/${ORG}`);
  await expect(page.getByRole('heading', { name: 'أهلاً في الحارة' })).toBeVisible();

  // And the database agrees there is exactly one live revision.
  const { rows } = await DB.query(
    `select count(*)::int as n from restaurant_website_revisions r
     join organizations o on o.id = r.organization_id
     where o.slug = $1 and r.is_live`,
    [ORG],
  );
  expect(rows[0].n).toBe(1);
});

test('reordering the draft does not move the public site until publish', async ({ page }) => {
  await actAs(page, 'owner@demo.local');
  await page.goto(BUILDER);

  for (const type of ['hero', 'about']) {
    await page.getByLabel('أضف قسمًا').selectOption(type);
    await page.getByRole('button', { name: 'إضافة' }).click();
  }
  // Give ABOUT some text so it renders at all.
  await page.getByRole('textbox', { name: 'النص' }).fill('مطعم شامي منذ سنوات.');
  await page.getByRole('button', { name: 'حفظ القسم' }).nth(1).click();

  await page.getByRole('button', { name: /نشر الموقع/ }).click();
  await expect(page.getByTestId('published-ok')).toBeVisible();

  const order = async () => {
    const { rows } = await DB.query(
      `select jsonb_agg(s ->> 'type' order by ord) as types
       from restaurant_website_revisions r
       join organizations o on o.id = r.organization_id,
       lateral jsonb_array_elements(r.sections) with ordinality as t(s, ord)
       where o.slug = $1 and r.is_live group by r.id`,
      [ORG],
    );
    return rows[0].types as string[];
  };
  expect(await order()).toEqual(['hero', 'about']);

  // Move ABOUT up in the draft.
  await page.goto(BUILDER);
  await page.getByRole('button', { name: 'تحريك لأعلى' }).nth(1).click();

  // Published order is unchanged until the second publish.
  expect(await order()).toEqual(['hero', 'about']);

  await page.getByRole('button', { name: /نشر التعديلات/ }).click();
  await expect(page.getByTestId('published-ok')).toBeVisible();
  expect(await order()).toEqual(['about', 'hero']);
});

test('a disabled section is left out of the published site', async ({ page }) => {
  await actAs(page, 'owner@demo.local');
  await page.goto(BUILDER);

  await page.getByLabel('أضف قسمًا').selectOption('hero');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await page.getByRole('textbox', { name: 'العنوان' }).first().fill('عنوان مخفي');
  await page.getByLabel('القسم ظاهر في الموقع').uncheck();
  await page.getByRole('button', { name: 'حفظ القسم' }).first().click();

  // Nothing enabled, so publishing is refused rather than blanking the site.
  await page.getByRole('button', { name: /نشر الموقع/ }).click();
  await expect(page.getByText(/أضف قسمًا واحدًا على الأقل/)).toBeVisible();

  await page.goto(`/r/${ORG}`);
  await expect(page.getByText('عنوان مخفي')).toHaveCount(0);
  await expect(page.locator('#menu')).toBeVisible();
});

test('unpublishing returns the public site to the default layout', async ({ page }) => {
  await actAs(page, 'owner@demo.local');
  await page.goto(BUILDER);
  await page.getByLabel('أضف قسمًا').selectOption('hero');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await page.getByRole('textbox', { name: 'العنوان' }).first().fill('تصميم مخصّص');
  await page.getByRole('button', { name: 'حفظ القسم' }).first().click();
  await page.getByRole('button', { name: /نشر الموقع/ }).click();
  await expect(page.getByTestId('published-ok')).toBeVisible();

  await page.goto(`/r/${ORG}`);
  await expect(page.getByRole('heading', { name: 'تصميم مخصّص' })).toBeVisible();

  await page.goto(BUILDER);
  await page.getByRole('button', { name: /إيقاف النشر/ }).click();
  await expect(page.getByText(/تم إيقاف النشر/)).toBeVisible();

  await page.goto(`/r/${ORG}`);
  await expect(page.getByText('تصميم مخصّص')).toHaveCount(0);
  await expect(page.locator('#menu')).toBeVisible();

  // The revision survives — unpublishing hides, it does not destroy.
  const { rows } = await DB.query(
    `select count(*)::int as n from restaurant_website_revisions r
     join organizations o on o.id = r.organization_id where o.slug = $1`,
    [ORG],
  );
  expect(rows[0].n).toBeGreaterThanOrEqual(1);
});

// ---------------------------------------------------------------------------
// Content safety at the surface
// ---------------------------------------------------------------------------

test('markup typed into the builder is refused, not rendered', async ({ page }) => {
  await actAs(page, 'owner@demo.local');
  await page.goto(BUILDER);
  await page.getByLabel('أضف قسمًا').selectOption('hero');
  await page.getByRole('button', { name: 'إضافة' }).click();

  await page
    .getByRole('textbox', { name: 'العنوان' })
    .first()
    .fill('<img src=x onerror=alert(1)>');
  await page.getByRole('button', { name: 'حفظ القسم' }).first().click();

  await expect(page.getByText(/لا يمكن استخدام رموز HTML/)).toBeVisible();

  const { rows } = await DB.query(
    `select count(*)::int as n from restaurant_website_sections s
     join organizations o on o.id = s.organization_id
     where o.slug = $1 and s.config::text like '%onerror%'`,
    [ORG],
  );
  expect(rows[0].n).toBe(0);
});

test('a non-https image URL is refused', async ({ page }) => {
  await actAs(page, 'owner@demo.local');
  await page.goto(BUILDER);
  await page.getByLabel('أضف قسمًا').selectOption('about');
  await page.getByRole('button', { name: 'إضافة' }).click();

  await page.getByRole('textbox', { name: 'رابط الصورة' }).fill('javascript:alert(1)');
  await page.getByRole('button', { name: 'حفظ القسم' }).first().click();
  await expect(page.getByText(/يجب أن يبدأ بـ https/)).toBeVisible();
});

// ---------------------------------------------------------------------------
// Theme, ordering and mobile
// ---------------------------------------------------------------------------

test('a theme applies to the published site and ordering still works', async ({ page }) => {
  await actAs(page, 'owner@demo.local');
  await page.goto(BUILDER);

  await page.getByLabel('أضف قسمًا').selectOption('hero');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await page.getByLabel('الخط').selectOption('cairo');
  await page.getByLabel('شكل الأزرار').selectOption('pill');
  await page.getByRole('button', { name: 'حفظ المظهر' }).click();
  await expect(page.getByText('تم الحفظ في المسودة.')).toBeVisible();

  await page.getByRole('button', { name: /نشر الموقع/ }).click();
  await expect(page.getByTestId('published-ok')).toBeVisible();

  await page.goto(`/r/${ORG}`);
  const style = await page.locator('div[style*="--lb-btn-radius"]').first().getAttribute('style');
  expect(style).toContain('9999px');

  // The ordering CTA still hands off to the D1 flow, unchanged.
  await page.getByRole('link', { name: /اطلب/ }).first().click();
  await expect(page).toHaveURL(new RegExp(`/order/${ORG}/main$`));
  await expect(page.getByRole('button', { name: 'أضف للسلة' }).first()).toBeVisible();
});

test('the builder and the published site work on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await actAs(page, 'owner@demo.local');

  await page.goto(BUILDER);
  await page.getByLabel('أضف قسمًا').selectOption('hero');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await page.getByRole('button', { name: /نشر الموقع/ }).click();
  await expect(page.getByTestId('published-ok')).toBeVisible();

  for (const path of [BUILDER, `${BUILDER}/preview`, `/r/${ORG}`]) {
    await page.goto(path);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} overflows horizontally on a phone`).toBeLessThanOrEqual(1);
  }
});
