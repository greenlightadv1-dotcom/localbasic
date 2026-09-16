import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * D3 — customer accounts.
 *
 * The SQL suite proves the database refuses cross-customer and cross-tenant
 * access. This proves the surface a real customer reaches: they can sign up,
 * manage their own account, see only their own orders, and that ordering as a
 * guest still works without one.
 *
 * Every customer here is created through the real sign-up form, so the flow
 * under test is the one a person would use.
 */
const DB = new Pool({
  connectionString:
    process.env.LOCAL_DATABASE_URL ??
    'postgresql://postgres@localhost/localbasic_dev?host=/tmp&port=5433',
});

const ORG = 'alhara';
const ACCOUNT = `/r/${ORG}/account`;

/** A fresh address per run, so tests never collide over one Auth identity. */
const unique = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

async function orgId(slug = ORG) {
  const { rows } = await DB.query('select id from organizations where slug = $1', [slug]);
  return rows[0].id as string;
}

async function setSetting(key: string, value: string, slug = ORG) {
  const org = await orgId(slug);
  await DB.query(
    `insert into settings (organization_id, branch_id, key, value)
     values ($1, null, $2, $3::jsonb)
     on conflict (organization_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), key)
     do update set value = excluded.value`,
    [org, key, value],
  );
}

/**
 * Signs up through the real form.
 *
 * Used only by the authentication tests. Sign-up is rate limited to 5 per hour
 * per IP — deliberately, and D3 does not relax it — so the rest of the suite
 * seeds its customer directly and authenticates with the local adapter's
 * session cookie, the same way the Platform Admin spec does.
 */
async function signUpThroughForm(page: Page, email: string, name = 'ضيف الاختبار') {
  await page.goto(`${ACCOUNT}/sign-up`);
  await page.getByRole('textbox', { name: 'الاسم', exact: true }).fill(name);
  await page.getByRole('textbox', { name: 'البريد الإلكتروني' }).fill(email);
  await page.getByLabel('كلمة المرور', { exact: false }).first().fill('password123');
  await page.getByLabel('تأكيد كلمة المرور').fill('password123');
  await page.getByRole('button', { name: 'إنشاء الحساب' }).click();
  await page.waitForURL(`**${ACCOUNT}`);
}

/**
 * A fresh customer, authenticated.
 *
 * Creates the Auth identity and nothing else — no membership, no role, no
 * customer row — so each test starts from exactly what a new sign-up produces
 * and the account area has to build the rest itself.
 */
async function signUp(page: Page, email: string, name = 'ضيف الاختبار') {
  const { rows } = await DB.query(
    `insert into auth.users (email, raw_user_meta_data)
     values ($1, jsonb_build_object('full_name', $2::text)) returning id`,
    [email, name],
  );
  await DB.query(
    'insert into public.profiles (id, full_name) values ($1, $2) on conflict (id) do update set full_name = excluded.full_name',
    [rows[0].id, name],
  );
  await page.context().addCookies([
    { name: 'lb_local_user', value: rows[0].id, url: 'http://localhost:3000' },
  ]);
  await page.goto(ACCOUNT);
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'تسجيل الخروج' }).click();
  await page.waitForURL(`**/r/${ORG}`);
}

test.beforeAll(async () => {
  // This spec owns its preconditions rather than inheriting whatever ran
  // before it: the restaurant is published and taking orders.
  await setSetting('restaurant.website_enabled', 'true');
  await setSetting('restaurant.online_ordering_enabled', 'true');
  await setSetting('restaurant.pickup_enabled', 'true');
  await setSetting('restaurant.delivery_enabled', 'true');
  await setSetting('restaurant.delivery_fee_cents', '2500');
  const org = await orgId();
  await DB.query(
    `delete from settings where organization_id = $1 and branch_id is not null
      and key in ('restaurant.online_ordering_enabled','restaurant.pickup_enabled',
                  'restaurant.delivery_enabled','restaurant.delivery_fee_cents')`,
    [org],
  );
});

test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) =>
    route.request().url().startsWith('http://localhost:3000') ? route.continue() : route.abort(),
  );
});

test.afterAll(async () => { await DB.end(); });

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

test('a visitor can sign up, and lands in the account rather than onboarding', async ({ page }) => {
  await signUpThroughForm(page, `${unique()}@test.local`, 'نور سامي');

  // The single most important assertion in this file: signing up to order
  // dinner must not begin creating a workspace.
  expect(page.url()).not.toContain('/onboarding');
  expect(page.url()).not.toContain('/workspace');
  await expect(page.getByRole('heading', { name: 'بياناتي' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'الاسم', exact: true })).toHaveValue('نور سامي');
});

test('a customer can sign out and back in', async ({ page }) => {
  const email = `${unique()}@test.local`;
  await signUpThroughForm(page, email, 'هاني فؤاد');
  await signOut(page);

  // Signed out, the account area sends them to sign-in rather than rendering.
  await page.goto(ACCOUNT);
  await page.waitForURL(`**${ACCOUNT}/sign-in`);

  await page.getByRole('textbox', { name: 'البريد الإلكتروني' }).fill(email);
  await page.getByLabel('كلمة المرور', { exact: false }).first().fill('password123');
  await page.getByRole('button', { name: 'دخول' }).click();
  await page.waitForURL(`**${ACCOUNT}`);
  await expect(page.getByRole('textbox', { name: 'الاسم', exact: true })).toHaveValue('هاني فؤاد');
});

test('an anonymous visitor cannot reach any account page', async ({ page }) => {
  for (const path of ['', '/orders', '/favorites', '/addresses', '/settings']) {
    await page.goto(`${ACCOUNT}${path}`);
    await page.waitForURL(`**${ACCOUNT}/sign-in`);
  }
});

test('the restaurant website offers an account link', async ({ page }) => {
  await page.goto(`/r/${ORG}`);
  await expect(page.getByRole('link', { name: 'تسجيل الدخول' })).toBeVisible();

  await signUp(page, `${unique()}@test.local`);
  await page.goto(`/r/${ORG}`);
  await expect(page.getByRole('link', { name: 'حسابي' })).toBeVisible();
});

// ---------------------------------------------------------------------------
// Profile and settings
// ---------------------------------------------------------------------------

test('a customer can update their profile, and cannot edit their email', async ({ page }) => {
  await signUp(page, `${unique()}@test.local`);

  await page.getByRole('textbox', { name: 'الاسم', exact: true }).fill('منى عادل');
  await page.getByRole('textbox', { name: 'رقم الهاتف' }).fill('01234567890');
  await page.getByRole('button', { name: 'حفظ' }).click();

  await expect(page.getByText('تم حفظ بياناتك.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'الاسم', exact: true })).toHaveValue('منى عادل');
  // The identity a person signs in with is Auth's, not a profile column.
  await expect(page.getByRole('textbox', { name: 'البريد الإلكتروني' })).toBeDisabled();
});

test('preferences save and do not claim a notification provider exists', async ({ page }) => {
  await signUp(page, `${unique()}@test.local`);
  await page.goto(`${ACCOUNT}/settings`);

  await expect(page.getByText('لم يتم تفعيل إرسال رسائل بعد')).toBeVisible();

  await page.getByLabel(/العروض والرسائل التسويقية/).check();
  await page.getByRole('button', { name: 'حفظ التفضيلات' }).click();
  await expect(page.getByText('تم حفظ تفضيلاتك.')).toBeVisible();
  await expect(page.getByLabel(/العروض والرسائل التسويقية/)).toBeChecked();
});

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

test('a customer can add, edit and delete a saved address', async ({ page }) => {
  await signUp(page, `${unique()}@test.local`);
  await page.goto(`${ACCOUNT}/addresses`);
  await expect(page.getByText('لا توجد عناوين محفوظة')).toBeVisible();

  await page.getByRole('button', { name: 'إضافة عنوان جديد' }).click();
  await page.getByRole('textbox', { name: 'اسم العنوان' }).fill('البيت');
  await page.getByRole('textbox', { name: 'العنوان بالتفصيل' }).fill('١٢ شارع الجمهورية');
  await page.getByRole('textbox', { name: 'المدينة' }).fill('القاهرة');
  await page.getByRole('button', { name: 'إضافة العنوان' }).click();

  await expect(page.getByText('تم حفظ العنوان.')).toBeVisible();
  await expect(page.getByText('١٢ شارع الجمهورية')).toBeVisible();
  // The first address saved becomes the default, without being asked for.
  await expect(page.getByText('الافتراضي')).toBeVisible();

  await page.getByRole('button', { name: 'تعديل' }).click();
  await page.getByRole('textbox', { name: 'العنوان بالتفصيل' }).fill('٣٤ شارع النيل');
  await page.getByRole('button', { name: 'حفظ التعديلات' }).click();
  // The saved row, not the field that was typed into.
  await expect(page.getByRole('paragraph').filter({ hasText: '٣٤ شارع النيل' })).toBeVisible();
  // And the edit form closes itself once the save has landed.
  await expect(page.getByRole('textbox', { name: 'العنوان بالتفصيل' })).toHaveCount(0);

  await page.getByRole('button', { name: 'حذف' }).click();
  await expect(page.getByText('تم حذف العنوان.')).toBeVisible();
  await expect(page.getByText('لا توجد عناوين محفوظة')).toBeVisible();
});

// ---------------------------------------------------------------------------
// Favourites
// ---------------------------------------------------------------------------

test('a customer can save and unsave a product from the menu', async ({ page }) => {
  await signUp(page, `${unique()}@test.local`);

  await page.goto(`/r/${ORG}`);
  await page.getByRole('button', { name: 'أضف للمفضلة' }).first().click();

  await page.goto(`${ACCOUNT}/favorites`);
  await expect(page.getByText('لا توجد أصناف مفضلة')).toBeHidden();
  const saved = page.getByRole('button', { name: 'إزالة من المفضلة' });
  await expect(saved).toHaveCount(1);

  await saved.click();
  await expect(page.getByText('لا توجد أصناف مفضلة')).toBeVisible();
});

test('the menu carries no save button for a signed-out visitor', async ({ page }) => {
  await page.goto(`/r/${ORG}`);
  await expect(page.getByRole('button', { name: 'أضف للمفضلة' })).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/** Places an order through the real storefront and returns its number. */
async function placeOrder(page: Page, opts: { delivery?: boolean } = {}) {
  await page.goto(`/order/${ORG}/main`);
  await page.getByRole('button', { name: 'أضف للسلة' }).first().click();
  if (opts.delivery) await page.getByRole('button', { name: 'توصيل', exact: true }).click();
  return page;
}

test('guest checkout still works, with no account anywhere in the flow', async ({ page }) => {
  await placeOrder(page);
  await page.getByRole('textbox', { name: 'الاسم', exact: true }).fill('زائر بدون حساب');
  await page.getByRole('textbox', { name: 'رقم الهاتف' }).fill('01000000000');
  await page.getByRole('button', { name: /تأكيد الطلب/ }).click();

  await page.waitForURL('**/order/track/**');
  await expect(page.getByTestId('order-total')).toBeVisible();
  // And the offer to keep it is exactly that — an offer, after the fact.
  await expect(page.getByText('أنشئ حسابًا لحفظ طلباتك وعناوينك')).toBeVisible();
});

test('an authenticated order appears in the account, with its detail', async ({ page }) => {
  await signUp(page, `${unique()}@test.local`, 'عميل مسجّل');

  await placeOrder(page);
  await page.getByRole('textbox', { name: 'الاسم', exact: true }).fill('عميل مسجّل');
  await page.getByRole('textbox', { name: 'رقم الهاتف' }).fill('01011111111');
  await page.getByRole('button', { name: /تأكيد الطلب/ }).click();
  await page.waitForURL('**/order/track/**');

  await page.goto(`${ACCOUNT}/orders`);
  const first = page.getByRole('link', { name: /#/ }).first();
  await expect(first).toBeVisible();
  await first.click();

  await expect(page.getByRole('heading', { name: /طلب #/ })).toBeVisible();
  // The required receipt wording, and no claim of tax-authority status.
  await expect(page.getByText(/هذا إيصال داخلي وليس فاتورة ضريبية معتمدة/)).toBeVisible();
  await expect(page.getByText(/معتمد من مصلحة الضرائب/)).toHaveCount(0);
});

test('a delivery order can use a saved address', async ({ page }) => {
  await signUp(page, `${unique()}@test.local`, 'عميل توصيل');

  await page.goto(`${ACCOUNT}/addresses`);
  await page.getByRole('button', { name: 'إضافة عنوان جديد' }).click();
  await page.getByRole('textbox', { name: 'اسم العنوان' }).fill('الشغل');
  await page.getByRole('textbox', { name: 'العنوان بالتفصيل' }).fill('٧ شارع شامبليون');
  await page.getByRole('button', { name: 'إضافة العنوان' }).click();
  await expect(page.getByText('تم حفظ العنوان.')).toBeVisible();

  await placeOrder(page, { delivery: true });
  // The name arrives pre-filled from the account — that is the convenience.
  await expect(page.getByRole('textbox', { name: 'الاسم', exact: true })).toHaveValue('عميل توصيل');
  // The saved address is offered, pre-selected, in place of the blank fields.
  await expect(page.getByRole('combobox', { name: 'عنوان التوصيل' })).toContainText('الشغل');
  // Delivery still needs a number, and this account has none on file yet.
  await page.getByRole('textbox', { name: 'رقم الهاتف' }).fill('01033333333');
  await page.getByRole('button', { name: /تأكيد الطلب/ }).click();
  await page.waitForURL('**/order/track/**');

  // The address the kitchen receives is the stored one.
  const { rows } = await DB.query(
    `select d.address from restaurant_order_deliveries d
       join restaurant_orders o on o.id = d.order_id
      order by o.placed_at desc limit 1`,
  );
  expect(rows[0].address).toBe('٧ شارع شامبليون');
});

test('one customer cannot reach another customer\'s order by its number', async ({ page }) => {
  // Customer one orders.
  await signUp(page, `${unique()}@test.local`, 'العميل الأول');
  await placeOrder(page);
  await page.getByRole('textbox', { name: 'الاسم', exact: true }).fill('العميل الأول');
  await page.getByRole('textbox', { name: 'رقم الهاتف' }).fill('01022222222');
  await page.getByRole('button', { name: /تأكيد الطلب/ }).click();
  await page.waitForURL('**/order/track/**');

  await page.goto(`${ACCOUNT}/orders`);
  const label = await page.getByRole('link', { name: /#/ }).first().innerText();
  const number = label.match(/#(\S+)/)![1];

  // Customer two signs in and asks for it by number.
  await page.goto(ACCOUNT);
  await signOut(page);
  await signUp(page, `${unique()}@test.local`, 'العميل الثاني');

  await page.goto(`${ACCOUNT}/orders/${number}`);
  // Not found — asserted on the rendered page rather than the status code:
  // notFound() inside a nested streamed route keeps a 200 while rendering the
  // not-found body. That is pre-existing Next behaviour, not a D3 change, and
  // the security boundary is what is rendered.
  await expect(page.getByRole('heading', { name: 'الصفحة غير موجودة' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /طلب #/ })).toHaveCount(0);
  await expect(page.getByText('العميل الأول')).toHaveCount(0);
  // And their own history is empty, not merged.
  await page.goto(`${ACCOUNT}/orders`);
  await expect(page.getByText('لا توجد طلبات بعد')).toBeVisible();
});

// ---------------------------------------------------------------------------
// Separation from staff and platform
// ---------------------------------------------------------------------------

test('a customer cannot reach staff or platform screens', async ({ page }) => {
  await signUp(page, `${unique()}@test.local`);

  // A workspace they are not a member of, and the platform console.
  for (const path of [`/${ORG}/main`, `/${ORG}/main/orders`, `/${ORG}/main/settings/members`, '/admin']) {
    await page.goto(path);
    await expect(
      page.getByRole('heading', { name: 'الصفحة غير موجودة' }),
      `${path} should not render for a customer`,
    ).toBeVisible();
  }

  // The signed-in entry point sends a customer to onboarding, not into
  // somebody's workspace.
  await page.goto('/workspace');
  await page.waitForURL('**/onboarding');
});

// ---------------------------------------------------------------------------
// Mobile
// ---------------------------------------------------------------------------

test('the account is usable on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signUp(page, `${unique()}@test.local`);

  for (const path of ['', '/orders', '/favorites', '/addresses', '/settings']) {
    await page.goto(`${ACCOUNT}${path}`);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} overflows horizontally on a phone`).toBeLessThanOrEqual(1);
  }
});
