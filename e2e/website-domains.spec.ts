import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * Custom domains, driven through the real screens.
 *
 * The SQL suite proves the database refuses cross-tenant access, duplicate
 * hostnames and unverified activation. This proves the flow an owner walks —
 * add, verify, activate — and, crucially, that a request arriving on the
 * hostname is served the right restaurant while the LocalBasic address keeps
 * working.
 *
 * Verification runs against the deterministic DNS fixture the dev server was
 * started with (LOCALBASIC_DNS_FIXTURE). That exercises the real lookup →
 * hash → state-machine path; only the DNS answer is a fixture, because owning
 * a domain is not a precondition this suite can satisfy.
 */
const DB = new Pool({
  connectionString:
    process.env.LOCAL_DATABASE_URL ??
    'postgresql://postgres@localhost/localbasic_dev?host=/tmp&port=5433',
});

const ORG = 'alhara';
const DOMAINS = `/${ORG}/main/settings/website/domains`;

/** Must match the value the dev server was started with. See the spec header. */
const TEST_HOST = 'alhara-test.localbasic-e2e.test';
const TEST_TOKEN = 'e2e-dns-fixture-token-000000';

async function orgId(slug = ORG) {
  const { rows } = await DB.query('select id from organizations where slug = $1', [slug]);
  return rows[0].id as string;
}

async function actAs(page: Page, email: string) {
  const { rows } = await DB.query('select id from auth.users where email = $1', [email]);
  await page.context().addCookies([
    { name: 'lb_local_user', value: rows[0].id, url: 'http://localhost:3000' },
  ]);
}

/** Clears domain rows so each test starts from a known state. */
async function resetDomains() {
  await DB.query('delete from restaurant_website_domains');
  const id = await orgId();
  await DB.query(
    `insert into settings (organization_id, branch_id, key, value)
     values ($1, null, 'restaurant.website_enabled', 'true'::jsonb)
     on conflict (organization_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), key)
     do update set value = excluded.value`,
    [id],
  );
}

/**
 * Seeds an ACTIVE domain directly, for the tests that are about RESOLUTION
 * rather than about the management flow. The management flow has its own test
 * that drives every step through the UI.
 */
async function seedActiveDomain(hostname: string, slug = ORG) {
  const id = await orgId(slug);
  await DB.query(
    `insert into restaurant_website_domains
       (organization_id, hostname, normalized_hostname, verification_token_hash,
        status, verified_at, activated_at)
     values ($1, $2, $2, 'seeded', 'verified', now(), now())`,
    [id, hostname],
  );
  await DB.query(
    "update restaurant_website_domains set status = 'active' where normalized_hostname = $1",
    [hostname],
  );
}

test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) =>
    route.request().url().startsWith('http://localhost:3000') ? route.continue() : route.abort(),
  );
  await resetDomains();
});

test.afterAll(async () => {
  await resetDomains();
  await DB.end();
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

test('a member without settings.manage cannot open the domains screen', async ({ page }) => {
  await actAs(page, 'kitchen@demo.local');
  await page.goto(DOMAINS);
  await expect(page.getByText('الصفحة غير موجودة')).toBeVisible();
});

test('another tenant cannot manage this restaurant domains', async ({ page }) => {
  const email = `dom-other-${Date.now().toString(36)}@demo.local`;
  const slug = `domother${Date.now().toString().slice(-6)}`;
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
  await page.goto(DOMAINS);
  await expect(page.getByText('الصفحة غير موجودة')).toBeVisible();
});

// ---------------------------------------------------------------------------
// The management flow, end to end
// ---------------------------------------------------------------------------

test('an owner adds, verifies and activates a domain', async ({ page }) => {
  await actAs(page, 'owner@demo.local');
  await page.goto(DOMAINS);
  await expect(page.getByRole('heading', { name: 'النطاقات' }).first()).toBeVisible();

  // Add — mixed case and a trailing dot, to prove normalization at the surface.
  await page.getByLabel('اسم النطاق').fill(`  ${TEST_HOST.toUpperCase()}.  `);
  await page.getByRole('button', { name: 'إضافة النطاق' }).click();

  // The challenge value is shown exactly once, with the record to create.
  await expect(page.getByText('لن تظهر هذه القيمة مرة أخرى')).toBeVisible();
  await expect(page.getByText(`_localbasic.${TEST_HOST}`).first()).toBeVisible();
  await expect(page.getByText('بانتظار التوثيق')).toBeVisible();
  // Normalized on the way in.
  await expect(page.getByText(TEST_HOST, { exact: true }).first()).toBeVisible();

  // Navigating away loses it — the database only kept a hash.
  await page.goto(DOMAINS);
  await expect(page.getByText('لن تظهر هذه القيمة مرة أخرى')).toHaveCount(0);

  // It is not active, so it serves nothing.
  expect(await servedSite(page, TEST_HOST)).toBeNull();

  // Verify. The dev server's DNS fixture publishes the matching TXT value, so
  // this runs the real lookup → hash → transition path.
  // Point the stored challenge at the value the dev server's DNS fixture
  // publishes. Everything else — the lookup, the hash comparison, the state
  // machine — is the real path. Uses the same hashing function the database
  // uses, so a mismatch here could only be a real mismatch.
  const rewritten = await DB.query(
    `update restaurant_website_domains
        set verification_token_hash = app.sha256_hex($1)
      where normalized_hostname = $2`,
    [TEST_TOKEN, TEST_HOST],
  );
  expect(rewritten.rowCount, 'the added domain row should exist').toBe(1);
  await page.getByRole('button', { name: 'تحقّق الآن' }).click();
  await expect(page.getByText('تم توثيق النطاق.')).toBeVisible();
  await expect(page.getByText('موثّق')).toBeVisible();

  // Activate.
  await page.getByRole('button', { name: 'تفعيل' }).click();
  await expect(page.getByTestId('domain-activated')).toBeVisible();
  await expect(page.getByText('مفعّل', { exact: true })).toBeVisible();
});

test('verification fails honestly when the DNS record is absent', async ({ page }) => {
  await actAs(page, 'owner@demo.local');
  await page.goto(DOMAINS);

  // A hostname the DNS fixture says nothing about.
  await page.getByLabel('اسم النطاق').fill('no-such-record.localbasic-e2e.test');
  await page.getByRole('button', { name: 'إضافة النطاق' }).click();
  // Wait for the add to land before navigating: reloading mid-action would
  // race the server action and leave nothing to verify.
  await expect(page.getByText('لن تظهر هذه القيمة مرة أخرى')).toBeVisible();
  await page.goto(DOMAINS);

  await page.getByRole('button', { name: 'تحقّق الآن' }).click();
  await expect(page.getByText('لم نعثر على سجل TXT مطابق بعد')).toBeVisible();
  await expect(page.getByText('بانتظار التوثيق')).toBeVisible();
  // And it stays unactivatable: there is no activate button on a pending row.
  await expect(page.getByRole('button', { name: 'تفعيل' })).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Public resolution — the runtime piece
// ---------------------------------------------------------------------------

/** Fetches a path with an explicit Host header, without following redirects. */
async function onHost(page: Page, host: string, path = '/') {
  return page.request.get(`http://localhost:3000${path}`, {
    headers: { host },
    maxRedirects: 0,
  });
}

/**
 * Was this request served a restaurant website, or the not-found page?
 *
 * Asserted on the document title rather than the status: notFound() inside a
 * nested streamed route renders the not-found page while keeping a 200 — a
 * pre-existing Next behaviour, not something this phase introduced. The
 * not-found template also appears inside every streamed response as part of
 * the error-boundary payload, so a body substring proves nothing; the title is
 * what the page actually resolved to.
 *
 * Returns the HTML when a site was served, and null when it was not.
 */
async function servedSite(page: Page, host: string, path = '/'): Promise<string | null> {
  const response = await onHost(page, host, path);
  const html = await response.text();
  // Next's own marker for a notFound() render, which is unambiguous where a
  // body substring is not.
  return html.includes('name="next-error" content="not-found"') ? null : html;
}

test('an active hostname serves that restaurant published website', async ({ page }) => {
  await seedActiveDomain(TEST_HOST);

  const html = await servedSite(page, TEST_HOST);

  // The restaurant's own content, on its own hostname.
  expect(html).toContain('مطعم الحارة الشامية');
  // The canonical points at the custom domain, not back at /r/<slug>.
  expect(html).toContain(`https://${TEST_HOST}`);
  expect(html).not.toMatch(/rel="canonical"[^>]*\/r\/alhara/);
});

test('the hostname decides the restaurant, and no parameter can override it', async ({ page }) => {
  // Two restaurants, each with its own hostname.
  const otherSlug = `domown${Date.now().toString().slice(-6)}`;
  const { rows } = await DB.query(
    'insert into auth.users (email) values ($1) returning id',
    [`dom-own-${Date.now().toString(36)}@demo.local`],
  );
  await DB.query(
    `select set_config('request.jwt.claims',
       json_build_object('sub', $1::text, 'role', 'authenticated')::text, false),
            set_config('role', 'authenticated', false)`,
    [rows[0].id],
  );
  await DB.query('select public.provision_workspace($1, $2, $3)', ['مطعم الجار', otherSlug, 'restaurant']);
  await DB.query("select set_config('role', 'postgres', false)");
  await DB.query(
    `insert into settings (organization_id, branch_id, key, value)
     select id, null, 'restaurant.website_enabled', 'true'::jsonb
     from organizations where slug = $1`,
    [otherSlug],
  );

  await seedActiveDomain(TEST_HOST);
  await seedActiveDomain('neighbour.localbasic-e2e.test', otherSlug);

  // Every client-controlled way of naming a different restaurant.
  for (const path of [
    '/?org=alhara',
    `/?organization=${ORG}`,
    `/?orgSlug=${ORG}`,
    '/?organization_id=00000000-0000-0000-0000-000000000000',
  ]) {
    const response = await onHost(page, 'neighbour.localbasic-e2e.test', path);
    const html = await response.text();
    expect(html, `${path} must not reach another restaurant`).toContain('مطعم الجار');
    expect(html, `${path} leaked another restaurant`).not.toContain('مطعم الحارة الشامية');
  }
});

test('pending and disabled hostnames do not resolve', async ({ page }) => {
  const id = await orgId();
  for (const status of ['pending', 'verified']) {
    await DB.query('delete from restaurant_website_domains');
    await DB.query(
      `insert into restaurant_website_domains
         (organization_id, hostname, normalized_hostname, verification_token_hash, status, verified_at)
       values ($1, $2, $2, 'seeded', $3, case when $3 = 'verified' then now() else null end)`,
      [id, TEST_HOST, status],
    );
    expect(await servedSite(page, TEST_HOST), `a ${status} domain must not resolve`).toBeNull();
  }

  // Active, then disabled: it stops serving.
  await DB.query('delete from restaurant_website_domains');
  await seedActiveDomain(TEST_HOST);
  expect(await servedSite(page, TEST_HOST)).toContain('مطعم الحارة الشامية');

  await DB.query(
    "update restaurant_website_domains set status = 'disabled' where normalized_hostname = $1",
    [TEST_HOST],
  );
  expect(await servedSite(page, TEST_HOST)).toBeNull();
});

test('an unknown or malformed hostname is not found', async ({ page }) => {
  for (const host of ['nobody-owns-this.localbasic-e2e.test', 'not a host', 'x']) {
    expect(await servedSite(page, host), `${host} should not resolve`).toBeNull();
  }
});

test('branch pages work on a custom domain, and unknown paths do not', async ({ page }) => {
  await seedActiveDomain(TEST_HOST);

  const { rows } = await DB.query(
    `select b.slug from branches b join organizations o on o.id = b.organization_id
      where o.slug = $1 and b.is_active and b.deleted_at is null order by b.created_at limit 1`,
    [ORG],
  );
  const branch = rows[0].slug as string;

  expect(await servedSite(page, TEST_HOST, `/${branch}`)).toContain('مطعم الحارة الشامية');

  // A path that is neither the root nor a branch is not found — which is what
  // keeps the marketing site, sign-in, the workspace and /admin off a
  // customer's domain.
  for (const path of ['/no-such-branch', '/admin', '/sign-in', `/${ORG}/main`, '/a/b/c']) {
    expect(
      await servedSite(page, TEST_HOST, path),
      `${path} must not be served on a custom domain`,
    ).toBeNull();
  }
});

test('an alias hostname points its canonical at the primary, without looping', async ({ page }) => {
  await seedActiveDomain(TEST_HOST);
  await seedActiveDomain(`www.${TEST_HOST}`);
  await DB.query(
    "update restaurant_website_domains set is_primary = true where normalized_hostname = $1",
    [TEST_HOST],
  );

  // The alias serves the site and names the primary as canonical.
  const alias = await servedSite(page, `www.${TEST_HOST}`);
  expect(alias).toContain('مطعم الحارة الشامية');
  expect(alias).toContain(`https://${TEST_HOST}`);
  expect(alias).not.toMatch(new RegExp(`rel="canonical"[^>]*www\\.${TEST_HOST}`));

  // The primary names itself — which is what stops a canonical loop.
  const primary = await servedSite(page, TEST_HOST);
  expect(primary).toContain(`https://${TEST_HOST}`);
});

test('the ordering flow still works from a custom domain', async ({ page }) => {
  await seedActiveDomain(TEST_HOST);
  const id = await orgId();
  for (const key of ['restaurant.online_ordering_enabled', 'restaurant.pickup_enabled']) {
    await DB.query(
      `insert into settings (organization_id, branch_id, key, value)
       values ($1, null, $2, 'true'::jsonb)
       on conflict (organization_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), key)
       do update set value = excluded.value`,
      [id, key],
    );
  }
  await DB.query(
    `delete from settings where organization_id = $1 and branch_id is not null
      and key in ('restaurant.online_ordering_enabled','restaurant.pickup_enabled')`,
    [id],
  );

  const response = await onHost(page, TEST_HOST);
  const html = await response.text();
  // The CTA names the restaurant's own ordering route, which carries its
  // identifiers and therefore works on any hostname.
  expect(html).toContain(`/order/${ORG}/`);

  // And that route is reachable on the custom domain, unrewritten.
  const order = await servedSite(page, TEST_HOST, `/order/${ORG}/main`);
  expect(order).not.toBeNull();
});

// ---------------------------------------------------------------------------
// The LocalBasic address keeps working
// ---------------------------------------------------------------------------

test('the LocalBasic URL still serves the website while a custom domain is active', async ({
  page,
}) => {
  await seedActiveDomain(TEST_HOST);

  await page.goto(`/r/${ORG}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('#menu')).toBeVisible();

  // And the platform's own hostname still serves the marketing site, not a
  // restaurant — the rewrite must not catch localhost.
  await page.goto('/');
  await expect(page).toHaveURL('http://localhost:3000/');
  const body = await page.locator('body').innerText();
  expect(body).not.toContain('مطعم الحارة الشامية');
});

// ---------------------------------------------------------------------------
// Verification hardening (migration 0044)
//
// The claim these prove is narrow and important: clicking Verify causes the
// SERVER to look up DNS, and nothing the browser sends can decide what is
// looked up or what comes back.
// ---------------------------------------------------------------------------

/** Points a domain's stored challenge at the value the DNS fixture publishes. */
async function pointChallengeAtFixtureToken(hostname: string) {
  const { rowCount } = await DB.query(
    `update restaurant_website_domains
        set verification_token_hash = app.sha256_hex($1)
      where normalized_hostname = $2`,
    [TEST_TOKEN, hostname],
  );
  expect(rowCount, `domain ${hostname} should exist`).toBe(1);
}

test('the Verify form gives the browser nothing to forge', async ({ page }) => {
  await actAs(page, 'owner@demo.local');
  await page.goto(DOMAINS);
  await page.getByLabel('اسم النطاق').fill(TEST_HOST);
  await page.getByRole('button', { name: 'إضافة النطاق' }).click();
  await expect(page.getByText('لن تظهر هذه القيمة مرة أخرى')).toBeVisible();
  await page.goto(DOMAINS);

  // Every field the form submits, by name, minus the one Next adds to route
  // the Server Action. The hostname to look up and the TXT values to compare
  // are both absent — they are read server-side.
  const names = await page
    .getByTestId('verify-form')
    .locator('input')
    .evaluateAll((els) =>
      els
        .map((e) => (e as HTMLInputElement).name)
        .filter((n) => !n.startsWith('$ACTION_'))
        .sort(),
    );

  expect(names).toEqual(['branchSlug', 'id', 'orgSlug']);
  expect(names).not.toContain('hostname');
  expect(names.some((n) => /txt|token|value|record/i.test(n))).toBe(false);
});

test('a forged hostname field cannot aim the DNS lookup', async ({ page }) => {
  await actAs(page, 'owner@demo.local');
  await page.goto(DOMAINS);

  // Two domains. TEST_HOST is the one the DNS fixture publishes a record for;
  // the other is a hostname this restaurant has no record for at all.
  const OTHER = 'not-ours.localbasic-e2e.test';
  for (const host of [TEST_HOST, OTHER]) {
    await page.getByLabel('اسم النطاق').fill(host);
    await page.getByRole('button', { name: 'إضافة النطاق' }).click();
    await expect(page.getByText('لن تظهر هذه القيمة مرة أخرى')).toBeVisible();
    await page.goto(DOMAINS);
  }

  // Both challenges now hash to the value the fixture publishes at
  // _localbasic.<TEST_HOST>. So if the attacker could choose which name is
  // looked up, OTHER would verify on a record it does not have.
  await pointChallengeAtFixtureToken(TEST_HOST);
  await pointChallengeAtFixtureToken(OTHER);
  await page.reload();

  // Find OTHER's row and inject the field the old flow used to read.
  const row = page.locator('li', { hasText: OTHER });
  await row.getByTestId('verify-form').evaluate((form, host) => {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'hostname';
    input.value = host;
    form.appendChild(input);
  }, TEST_HOST);

  await row.getByRole('button', { name: 'تحقّق الآن' }).click();
  await expect(page.getByText('لم نعثر على سجل TXT مطابق بعد')).toBeVisible();

  // The forged field changed nothing: OTHER is still pending, and the
  // database agrees — this is the assertion that would have failed before.
  const { rows } = await DB.query(
    'select status, verified_at from restaurant_website_domains where normalized_hostname = $1',
    [OTHER],
  );
  expect(rows[0].status).toBe('pending');
  expect(rows[0].verified_at).toBeNull();

  // And the legitimate one still verifies, through the same button, because
  // the server looks up its own name.
  const good = page.locator('li', { hasText: new RegExp(`^(?!.*${OTHER}).*${TEST_HOST}`) }).first();
  await good.getByRole('button', { name: 'تحقّق الآن' }).click();
  await expect(page.getByText('تم توثيق النطاق.')).toBeVisible();
});

test('the Verify button reaches the server-side resolver, not a client claim', async ({ page }) => {
  await actAs(page, 'owner@demo.local');
  await page.goto(DOMAINS);
  await page.getByLabel('اسم النطاق').fill(TEST_HOST);
  await page.getByRole('button', { name: 'إضافة النطاق' }).click();
  await expect(page.getByText('لن تظهر هذه القيمة مرة أخرى')).toBeVisible();
  await page.goto(DOMAINS);

  // With the stored challenge NOT matching what the fixture publishes, the
  // lookup happens and honestly finds nothing that matches.
  await page.getByRole('button', { name: 'تحقّق الآن' }).click();
  await expect(page.getByText('لم نعثر على سجل TXT مطابق بعد')).toBeVisible();
  await expect(page.getByText('بانتظار التوثيق')).toBeVisible();

  // Now the fixture's record is the right one. Nothing about the request
  // changed — only what DNS answers — and that flips the outcome. A client
  // claim could not produce this difference.
  await pointChallengeAtFixtureToken(TEST_HOST);
  await page.reload();
  await page.getByRole('button', { name: 'تحقّق الآن' }).click();
  await expect(page.getByText('تم توثيق النطاق.')).toBeVisible();

  const { rows } = await DB.query(
    'select status from restaurant_website_domains where normalized_hostname = $1',
    [TEST_HOST],
  );
  expect(rows[0].status).toBe('verified');
});

test('the verification attempt is audited with the acting user', async ({ page }) => {
  await actAs(page, 'owner@demo.local');
  await page.goto(DOMAINS);
  await page.getByLabel('اسم النطاق').fill(TEST_HOST);
  await page.getByRole('button', { name: 'إضافة النطاق' }).click();
  await expect(page.getByText('لن تظهر هذه القيمة مرة أخرى')).toBeVisible();
  await page.goto(DOMAINS);
  await page.getByRole('button', { name: 'تحقّق الآن' }).click();
  await expect(page.getByText('لم نعثر على سجل TXT مطابق بعد')).toBeVisible();

  // The write now runs as the service role, which has no session — so the
  // actor has to travel explicitly or the audit trail loses who did it.
  const { rows } = await DB.query(
    `select a.actor_id, u.email, a.after
       from audit_logs a
       join auth.users u on u.id = a.actor_id
      where a.action = 'restaurant.domain_verification_attempted'
      order by a.created_at desc limit 1`,
  );
  expect(rows[0]?.email).toBe('owner@demo.local');
  expect(rows[0].after.hostname).toBe(TEST_HOST);
  expect(rows[0].after.verified).toBe(false);
  // And no verification material rode along.
  expect(JSON.stringify(rows[0].after)).not.toContain(TEST_TOKEN);
});
