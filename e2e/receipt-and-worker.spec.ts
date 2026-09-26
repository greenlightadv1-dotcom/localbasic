import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * The printable receipt and the notification worker.
 *
 * Email invitations were removed from the staff dashboard entirely — staff
 * accounts are created directly (see settings/members/invite-forms.tsx) — so
 * the invitation-flow tests this file used to carry went with them. What
 * remains proves a completed order's receipt prints with the wording the
 * platform is required to show, and that the notification worker's endpoint
 * is closed to anyone without its secret.
 */
const DB = new Pool({
  connectionString:
    process.env.LOCAL_DATABASE_URL ??
    'postgresql://postgres@localhost/localbasic_dev?host=/tmp&port=5433',
});

const ORG = 'alhara';

async function userId(email: string) {
  const { rows } = await DB.query('select id from auth.users where email = $1', [email]);
  return rows[0].id as string;
}

async function actAs(page: Page, id: string) {
  await page.context().addCookies([
    { name: 'lb_local_user', value: id, url: 'http://localhost:3000' },
  ]);
}

test.afterAll(async () => {
  await DB.end();
});

test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) =>
    route.request().url().startsWith('http://localhost:3000') ? route.continue() : route.abort(),
  );
});

// ---------------------------------------------------------------------------
// The printable receipt
// ---------------------------------------------------------------------------

test('a paid order prints a receipt that derives its own figures', async ({ page }) => {
  // A real paid invoice, produced by the flow rather than written by hand.
  const { rows: invoices } = await DB.query(
    `select i.id, i.total_cents from invoices i
      join organizations o on o.id = i.organization_id
     where o.slug = $1 and i.paid_cents > 0
     order by i.created_at desc limit 1`,
    [ORG],
  );
  test.skip(invoices.length === 0, 'the demo data has no paid invoice yet');

  await actAs(page, await userId('owner@demo.local'));
  await page.goto(`/${ORG}/main/invoices/${invoices[0].id}`);

  // The document calls itself a RECEIPT.
  await expect(page.getByText('إيصال').first()).toBeVisible();

  // And the required disclaimer is on the document that gets handed over.
  const disclaimer = page.getByTestId('receipt-disclaimer');
  await expect(disclaimer).toBeVisible();
  await expect(disclaimer).toContainText('هذا إيصال داخلي وليس فاتورة ضريبية');

  // The phrase "tax invoice" appears ONLY inside that disclaimer, where it is
  // being denied. Anywhere else would be the document claiming to be one.
  const taxInvoiceMentions = await page.getByText('فاتورة ضريبية').count();
  const insideDisclaimer = await disclaimer.getByText('فاتورة ضريبية').count();
  expect(taxInvoiceMentions).toBe(insideDisclaimer);

  // The total on the page is the one the database holds. Nothing about the
  // figure came from the URL, which carries only an id.
  const body = await page.locator('body').innerText();
  const expected = (Number(invoices[0].total_cents) / 100).toLocaleString('ar-EG', {
    minimumFractionDigits: 2,
  });
  expect(body).toContain(expected);
});

test('a receipt that is not this restaurant’s is not found', async ({ page }) => {
  await actAs(page, await userId('owner@demo.local'));

  // A well-formed id that belongs to nobody.
  await page.goto(`/${ORG}/main/invoices/00000000-0000-0000-0000-000000000000`);
  await expect(page.getByTestId('receipt-disclaimer')).toHaveCount(0);

  // And one that belongs to somebody else, when the database has one — the
  // same answer, which is the point.
  const { rows } = await DB.query(
    `select i.id from invoices i
      join organizations o on o.id = i.organization_id
     where o.slug <> $1 limit 1`,
    [ORG],
  );
  if (rows.length > 0) {
    await page.goto(`/${ORG}/main/invoices/${rows[0].id}`);
    await expect(page.getByTestId('receipt-disclaimer')).toHaveCount(0);
  }
});

// ---------------------------------------------------------------------------
// The notification worker's front door
// ---------------------------------------------------------------------------

test('the worker endpoint refuses callers without the secret', async ({ page }) => {
  // No NOTIFICATION_WORKER_SECRET is set in this environment, so the route is
  // closed — a queue that does not run is recoverable; one anybody can drive
  // is not.
  const response = await page.request.post('/api/worker/notifications');
  expect([404, 503]).toContain(response.status());

  const wrong = await page.request.post('/api/worker/notifications', {
    headers: { 'x-worker-secret': 'guessed' },
  });
  expect([404, 503]).toContain(wrong.status());
});
