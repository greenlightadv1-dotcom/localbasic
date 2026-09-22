import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * The Site Engine, driven through the real screens.
 *
 * The SQL suite proves the database refuses cross-tenant writes, holds the
 * homepage invariant and keeps revisions immutable. The unit suite proves the
 * renderer, the resolver and the services in isolation. Neither of them ever
 * opens a browser, so this walks the one journey an owner actually performs:
 *
 *   create a site → add a page → add a section → save → preview → set the
 *   appearance → publish → confirm a live revision exists → roll back
 *
 * ONE test, deliberately. This is a smoke test for manual-verification
 * readiness, not a replacement for the suites above: it answers "does the
 * wiring hold end to end", and a second scenario would only slow that answer
 * down.
 *
 * Auth is the `lb_local_user` cookie the local adapter reads, exactly as
 * website-builder.spec.ts does.
 *
 * RUNNING THIS. The dev server must have the offline adapter switched on, or
 * the cookie is ignored and every screen answers "unauthenticated":
 *
 *   ./scripts/dev-db.sh                 # schema 0001-0060 + demo data
 *   LOCALBASIC_LOCAL_DB=1 npm run dev
 *   npx playwright test e2e/site-engine.spec.ts
 *
 * Creating a site costs one `provisionWorkspace` token, and that bucket allows
 * 3 per hour per user and organization. The limiter is in-memory, so it is
 * held per dev-server PROCESS: a fourth consecutive run inside the hour will
 * fail at the redirect after "إنشاء الموقع" until the server is restarted.
 * That is the rate limiter working, not a defect in the Site Engine.
 */
const DB = new Pool({
  connectionString:
    process.env.LOCAL_DATABASE_URL ??
    'postgresql://postgres@localhost/localbasic_dev?host=/tmp&port=5433',
});

const ORG = 'alhara';
const SITES = `/${ORG}/main/settings/sites`;

/** Unique per run, so the test is repeatable without a reset step. */
const SLUG = `smoke-${Date.now().toString(36)}`;

async function actAs(page: Page, email: string) {
  const { rows } = await DB.query('select id from auth.users where email = $1', [email]);
  await page.context().addCookies([
    { name: 'lb_local_user', value: rows[0].id, url: 'http://localhost:3000' },
  ]);
}

test.afterAll(async () => {
  // Only this run's site. Cascades to its pages, sections, settings and
  // revisions, and leaves the demo data alone.
  await DB.query('delete from sites where slug = $1', [SLUG]);
  await DB.end();
});

test('an owner creates, edits, previews, publishes and rolls back a site', async ({ page }) => {
  await actAs(page, 'owner@demo.local');

  // ── Create ────────────────────────────────────────────────────────────────
  await page.goto(SITES);
  await expect(page.getByRole('heading', { name: 'المواقع الإلكترونية' })).toBeVisible();

  // Form fields are addressed by their `name` attribute rather than their
  // Arabic label: the labels carry a required-marker span, and several screens
  // legitimately reuse the same words. The name is what the server action
  // reads, so it is both stable and the thing actually under test.
  await page.locator('input[name="name"]').fill('موقع الاختبار');
  await page.locator('input[name="slug"]').fill(SLUG);
  await page.getByRole('button', { name: 'إنشاء الموقع' }).click();

  // Provisioning redirects to the new site, which already has a homepage.
  await page.waitForURL(new RegExp(`${SITES}/[0-9a-f-]{36}$`));
  const siteUrl = page.url();
  await expect(page.getByRole('heading', { name: 'موقع الاختبار' })).toBeVisible();

  // ── Add a page ────────────────────────────────────────────────────────────
  await page.locator('input[name="title"]').fill('من نحن');
  await page.locator('input[name="slug"]').fill('about-us');
  await page.getByRole('button', { name: 'إضافة صفحة' }).click();

  // Creating a page opens its section editor.
  await page.waitForURL(/\/pages\/[0-9a-f-]{36}/);
  await expect(page.getByRole('heading', { name: 'من نحن' })).toBeVisible();

  // ── Add a section, and save content into it ───────────────────────────────
  await page.locator('select[name="sectionType"]').selectOption('about');
  await page.getByRole('button', { name: 'إضافة قسم' }).click();
  await expect(page.getByText('تمت إضافة القسم')).toBeVisible();

  await page.locator('input[name="title"]').fill('قسم الاختبار');
  await page.getByRole('button', { name: 'حفظ القسم' }).click();
  await expect(page.getByText('تم حفظ القسم')).toBeVisible();

  // ── Preview renders the saved content ─────────────────────────────────────
  await page.getByRole('link', { name: 'معاينة هذه الصفحة' }).click();
  await page.waitForURL(/\/preview\?page=/);
  await expect(page.getByText('قسم الاختبار')).toBeVisible();

  // ── Appearance reaches the renderer ───────────────────────────────────────
  // Saving a colour is only half the claim. The other half is that the theme
  // actually drives the rendered page, so this asserts on the RGB channels the
  // renderer emits for #b91c1c rather than on the form echoing back its input.
  await page.goto(siteUrl);
  await page.locator('input[name="primary"]').fill('#b91c1c');
  await page.getByRole('button', { name: 'حفظ المظهر' }).click();
  await expect(page.getByText('تم حفظ التغييرات')).toBeVisible();

  // A reload proves it was persisted, not just held in the form's state.
  await page.reload();
  await expect(page.locator('input[name="primary"]')).toHaveValue('#b91c1c');

  await page.goto(`${siteUrl}/preview`);
  expect(await page.content()).toContain('185 28 28');

  // ── Publish ───────────────────────────────────────────────────────────────
  await page.goto(siteUrl);
  await expect(page.getByText('غير منشور')).toBeVisible();

  await page.getByRole('button', { name: 'نشر الموقع' }).click();
  // Asserted on the VERSION, not just the words: the same banner appears after
  // every publish, so a version-less match would pass on the previous one and
  // race ahead of the write it is supposed to be waiting for.
  await expect(page.getByText('تم نشر النسخة 1')).toBeVisible();

  // The live revision is a database fact, not a rendered string: assert on the
  // row, so a green badge over an empty ledger cannot pass.
  const live = await DB.query(
    `select r.version, r.snapshot from site_revisions r
       join sites s on s.id = r.site_id
      where s.slug = $1 and r.is_live`,
    [SLUG],
  );
  expect(live.rowCount).toBe(1);
  expect(live.rows[0].version).toBe(1);
  // The snapshot froze the section that was saved, not an empty page.
  expect(JSON.stringify(live.rows[0].snapshot)).toContain('قسم الاختبار');

  // ── Publish again, then roll back to version 1 ────────────────────────────
  await page.getByRole('button', { name: 'نشر نسخة جديدة' }).click();
  await expect(page.getByText('تم نشر النسخة 2')).toBeVisible();

  const second = await DB.query(
    `select count(*)::int as n from site_revisions r
       join sites s on s.id = r.site_id where s.slug = $1`,
    [SLUG],
  );
  expect(second.rows[0].n).toBe(2);

  // Version 1 is no longer live, so the history offers to restore it.
  await page.getByRole('button', { name: 'إعادة نشر النسخة 1' }).click();
  await page.getByRole('button', { name: 'إعادة النشر', exact: true }).click();
  await expect(page.getByText('تمت إعادة نشر النسخة 1')).toBeVisible();

  // Exactly one revision is live, and it is version 1 again.
  const after = await DB.query(
    `select r.version from site_revisions r
       join sites s on s.id = r.site_id
      where s.slug = $1 and r.is_live`,
    [SLUG],
  );
  expect(after.rowCount).toBe(1);
  expect(after.rows[0].version).toBe(1);
});
