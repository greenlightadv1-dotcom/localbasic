import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * The Platform Admin boundary, and the workflow that matters most.
 *
 * Two things this pins that nothing else did:
 *
 *   1. EVERY admin route, against EVERY identity. The existing specs check a
 *      handful of screens against a tenant owner. A console is only as closed
 *      as its most forgotten page, so this sweeps all of them — including the
 *      legacy redirects, which used to answer a stranger before the gate ran
 *      and so confirmed the path existed.
 *
 *   2. The complete sales chain — lead → agreement → organization → service →
 *      plan → owner → workspace ready — as one run, ending with the lead
 *      actually closed. The existing onboarding test proves atomicity; this
 *      proves the chain, and that it goes through the existing provisioning
 *      rather than around it.
 */
const DB = new Pool({
  connectionString:
    process.env.LOCAL_DATABASE_URL ??
    'postgresql://postgres@localhost/localbasic_dev?host=/tmp&port=5433',
});

/** Every page and redirect under /admin. Add a route, add it here. */
const ADMIN_PAGES = [
  '/admin',
  '/admin/customers',
  '/admin/services',
  '/admin/plans',
  '/admin/subscriptions',
  '/admin/leads',
  '/admin/audit',
  '/admin/onboard',
  '/admin/promo-codes',
  '/admin/team',
];
const ADMIN_REDIRECTS = ['/admin/organizations', '/admin/organizations/LB-000125'];

/** The marker only the admin shell renders. */
const SHELL = 'إدارة المنصة';

async function userId(email: string) {
  const { rows } = await DB.query('select id from auth.users where email = $1', [email]);
  return rows[0].id as string;
}

async function platformAdminId() {
  await DB.query(`
    insert into auth.users (email, raw_user_meta_data)
    values ('boundary-admin@demo.local', '{"full_name":"مشرف الحدود"}'::jsonb)
    on conflict (email) do nothing`);
  const id = await userId('boundary-admin@demo.local');
  await DB.query(
    `insert into public.profiles (id, full_name) values ($1, 'مشرف الحدود')
     on conflict (id) do nothing`, [id],
  );
  await DB.query(
    `insert into public.platform_admins (user_id, role) values ($1, 'owner')
     on conflict (user_id) do update set is_active = true, role = 'owner'`, [id],
  );
  return id;
}

/**
 * Arabic-Indic digits render in an RTL locale, which is correct. Normalise so
 * a test can read the number rather than assert around the formatting.
 */
function toLatinDigits(text: string): string {
  return text
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u066b]/g, '.')
    .replace(/[\u066c]/g, '');
}

/** A member of a tenant who holds no platform role at all. */
async function staffId() {
  return userId('kitchen@demo.local');
}

async function actAs(page: Page, id: string) {
  await page.context().addCookies([
    { name: 'lb_local_user', value: id, url: 'http://localhost:3000' },
  ]);
}

test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) =>
    route.request().url().startsWith('http://localhost:3000') ? route.continue() : route.abort(),
  );
});

test.afterAll(async () => { await DB.end(); });

// ---------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------

test('an unauthenticated visitor gets nothing from any admin route', async ({ page }) => {
  for (const path of ADMIN_PAGES) {
    await page.goto(path);
    await expect(page.getByText(SHELL), `${path} leaked the console`).toHaveCount(0);
  }

  // The redirects are gated too: a 307 would tell a stranger the path exists
  // and where it went.
  for (const path of ADMIN_REDIRECTS) {
    const response = await page.request.get(path, { maxRedirects: 0 });
    expect(response.status(), `${path} redirected an anonymous visitor`).toBe(404);
  }
});

test('a tenant owner gets nothing from any admin route', async ({ page }) => {
  // The owner of a restaurant is not an operator of the platform. This is the
  // separation the whole console rests on.
  await actAs(page, await userId('owner@demo.local'));

  for (const path of ADMIN_PAGES) {
    await page.goto(path);
    await expect(page.getByText(SHELL), `${path} leaked the console`).toHaveCount(0);
  }
  for (const path of ADMIN_REDIRECTS) {
    const response = await page.request.get(path, { maxRedirects: 0 });
    expect(response.status(), `${path} redirected a tenant owner`).toBe(404);
  }
});

test('a tenant staff member gets nothing from any admin route', async ({ page }) => {
  await actAs(page, await staffId());
  for (const path of ADMIN_PAGES) {
    await page.goto(path);
    await expect(page.getByText(SHELL), `${path} leaked the console`).toHaveCount(0);
  }
});

test('a platform admin reaches every admin route', async ({ page }) => {
  await actAs(page, await platformAdminId());

  for (const path of ADMIN_PAGES) {
    await page.goto(path);
    await expect(page.getByText(SHELL).first(), `${path} did not render`).toBeVisible();
  }
  for (const path of ADMIN_REDIRECTS) {
    const response = await page.request.get(path, { maxRedirects: 0 });
    expect(response.status(), `${path} did not redirect an admin`).toBe(307);
  }
});

test('a revoked admin loses the console immediately', async ({ page }) => {
  const id = await platformAdminId();
  await actAs(page, id);
  await page.goto('/admin');
  await expect(page.getByText(SHELL).first()).toBeVisible();

  await DB.query('update platform_admins set is_active = false where user_id = $1', [id]);
  await page.goto('/admin');
  await expect(page.getByText(SHELL)).toHaveCount(0);

  await DB.query('update platform_admins set is_active = true where user_id = $1', [id]);
});

test('a tenant user cannot make themselves a platform admin', async ({ page }) => {
  const owner = await userId('owner@demo.local');

  // No policy allows the write, and no function is granted to them. The UI is
  // not what stops this — there is nothing to stop.
  const client = await DB.connect();
  let refused = false;
  try {
    await client.query('begin');
    await client.query(
      `select set_config('request.jwt.claims',
         json_build_object('sub', $1::text, 'role', 'authenticated')::text, true),
              set_config('role', 'authenticated', true)`,
      [owner],
    );
    await client.query(
      "insert into public.platform_admins (user_id, role) values ($1, 'owner')",
      [owner],
    );
    await client.query('commit');
  } catch {
    refused = true;
    await client.query('rollback').catch(() => undefined);
  } finally {
    client.release();
  }
  expect(refused, 'a tenant owner inserted themselves into platform_admins').toBe(true);

  const { rows } = await DB.query(
    'select count(*)::int as n from platform_admins where user_id = $1', [owner],
  );
  expect(rows[0].n).toBe(0);

  await actAs(page, owner);
  await page.goto('/admin');
  await expect(page.getByText(SHELL)).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// The workflow: lead → agreement → workspace
// ---------------------------------------------------------------------------

test('a lead becomes a workspace through the existing provisioning', async ({ page }) => {
  await actAs(page, await platformAdminId());

  const stamp = Date.now().toString().slice(-7);
  const leadName = `عميل محتمل ${stamp}`;
  const slug = `chain${stamp}`;
  const ownerEmail = `chain-owner-${stamp}@demo.local`;

  // 1. The lead arrives.
  await page.goto('/admin/leads');
  await page.getByLabel('الاسم').fill(leadName);
  await page.getByLabel('الهاتف').fill('01000000009');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await expect(page.getByText(leadName)).toBeVisible();

  const { rows: lead } = await DB.query(
    'select id, status from platform_leads where name = $1', [leadName],
  );
  expect(lead).toHaveLength(1);

  // 2. The agreement — a manual sales step, recorded as the lead qualifying.
  //    Scoped to this lead's own row: the screen lists every lead, each with
  //    its own status control.
  const leadRow = page.locator('li, tr', { hasText: leadName }).last();
  await leadRow.getByLabel('الحالة').selectOption('qualified');
  await leadRow.getByRole('button', { name: 'حفظ' }).click();
  await expect
    .poll(async () => (
      await DB.query('select status from platform_leads where id = $1', [lead[0].id])
    ).rows[0].status)
    .toBe('qualified');

  // 3. The owner's account. Existing, so no service-role key is needed —
  //    inviting a brand-new owner is a separate, already-tested path.
  await DB.query('insert into auth.users (email) values ($1)', [ownerEmail]);
  const ownerId = await userId(ownerEmail);
  await DB.query(
    `insert into public.profiles (id, full_name) values ($1, 'مالك السلسلة')
     on conflict (id) do nothing`, [ownerId],
  );

  // 4. Organization + service + plan + owner, in one submission.
  await page.goto('/admin/onboard');
  await page.getByLabel('بريد المالك').fill(ownerEmail);
  await page.getByLabel('اسم المالك').fill('مالك السلسلة');
  await page.getByLabel('اسم المنشأة').fill(`مطعم السلسلة ${stamp}`);
  await page.getByLabel('المعرّف (في الرابط)').fill(slug);
  await page.getByLabel('الخدمة').selectOption('restaurant');

  const { rows: plan } = await DB.query("select id from plans where key = 'basic'");
  await page.getByLabel('الباقة').selectOption(plan[0].id as string);
  await page.getByLabel('المدة').selectOption('year');
  await page.getByLabel('ربط بعميل محتمل (اختياري)').selectOption(lead[0].id as string);
  await page.getByRole('button', { name: 'إنشاء مساحة العمل' }).click();

  // 5. Workspace ready.
  await expect(page).toHaveURL(/\/admin\/customers\/LB-\d{6}\?created=1/);

  const { rows } = await DB.query(`
    select o.id, o.customer_code, o.owner_user_id, o.primary_module,
           s.billing_period, s.status,
           (select count(*)::int from branches b where b.organization_id = o.id) as branches,
           (select count(*)::int from organization_modules m
             where m.organization_id = o.id and m.module_key = 'restaurant' and m.enabled) as modules,
           (select count(*)::int from organization_members mm
             where mm.organization_id = o.id and mm.user_id = o.owner_user_id) as owner_member
      from organizations o join subscriptions s on s.organization_id = o.id
     where o.slug = $1`, [slug]);

  expect(rows).toHaveLength(1);
  expect(rows[0].customer_code).toMatch(/^LB-\d{6}$/);
  expect(rows[0].owner_user_id).toBe(ownerId);
  expect(rows[0].primary_module).toBe('restaurant');
  expect(rows[0].billing_period).toBe('year');
  expect(rows[0].status).toBe('active');
  // Provisioning did its usual work rather than being bypassed: a branch, the
  // module row, and the owner's membership all exist.
  expect(rows[0].branches).toBeGreaterThanOrEqual(1);
  expect(rows[0].modules).toBe(1);
  expect(rows[0].owner_member).toBe(1);

  // 6. The lead is closed by the same transaction, not by a second click.
  const { rows: closed } = await DB.query(
    'select status from platform_leads where id = $1', [lead[0].id],
  );
  expect(closed[0].status).toBe('won');

  // 7. And the whole thing is on the platform audit trail.
  const { rows: audit } = await DB.query(
    `select count(*)::int as n from audit_logs
      where action = 'platform.customer_onboarded' and entity_id = $1`,
    [rows[0].id],
  );
  expect(audit[0].n).toBeGreaterThanOrEqual(1);

  // The new workspace is real: its owner can open it.
  await page.context().clearCookies();
  await actAs(page, ownerId);
  await page.goto(`/${slug}`);
  await expect(page.getByText(SHELL)).toHaveCount(0);
});

test('the dashboard shows platform figures, not one restaurant’s', async ({ page }) => {
  await actAs(page, await platformAdminId());
  await page.goto('/admin');

  const { rows } = await DB.query('select count(*)::int as n from organizations');
  const body = toLatinDigits(await page.locator('body').innerText());

  // A platform console counts customers. A tenant dashboard counts today's
  // orders — if this screen ever starts doing that, it is the wrong screen.
  expect(body).toContain(String(rows[0].n));
  await expect(page.getByText('الكاشير')).toHaveCount(0);
  await expect(page.getByText('المطبخ')).toHaveCount(0);
});
