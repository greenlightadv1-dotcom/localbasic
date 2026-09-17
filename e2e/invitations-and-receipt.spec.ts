import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * Inviting a colleague, the printable receipt, and the notification worker.
 *
 * The SQL suite proves the database refuses a reused, expired or misaddressed
 * invitation and that only the service role may work the outbox. This proves
 * what a person actually does: a manager creates an invitation, the invitee
 * follows the link and lands inside the workspace, and a completed order's
 * receipt prints with the wording the platform is required to show.
 */
const DB = new Pool({
  connectionString:
    process.env.LOCAL_DATABASE_URL ??
    'postgresql://postgres@localhost/localbasic_dev?host=/tmp&port=5433',
});

const ORG = 'alhara';
const MEMBERS = `/${ORG}/main/settings/members`;
const INVITEE = 'invite-e2e@demo.local';
const OUTSIDER = 'invite-outsider@demo.local';

let inviteeId = '';
let outsiderId = '';
let orgId = '';

async function userId(email: string) {
  const { rows } = await DB.query('select id from auth.users where email = $1', [email]);
  return rows[0].id as string;
}

async function makeUser(email: string, name: string): Promise<string> {
  await DB.query(
    `insert into auth.users (email, raw_user_meta_data)
     values ($1, jsonb_build_object('full_name', $2::text))
     on conflict (email) do nothing`,
    [email, name],
  );
  const id = await userId(email);
  await DB.query(
    `insert into public.profiles (id, full_name) values ($1, $2)
     on conflict (id) do nothing`,
    [id, name],
  );
  return id;
}

async function actAs(page: Page, id: string) {
  await page.context().addCookies([
    { name: 'lb_local_user', value: id, url: 'http://localhost:3000' },
  ]);
}

test.beforeAll(async () => {
  inviteeId = await makeUser(INVITEE, 'زميل جديد');
  outsiderId = await makeUser(OUTSIDER, 'شخص آخر');
  const { rows } = await DB.query('select id from organizations where slug = $1', [ORG]);
  orgId = rows[0].id as string;
});

test.afterAll(async () => {
  await DB.query('delete from invitations where organization_id = $1', [orgId]);
  await DB.query(
    `delete from organization_members where organization_id = $1 and user_id = any($2)`,
    [orgId, [inviteeId, outsiderId]],
  );
  await DB.end();
});

test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) =>
    route.request().url().startsWith('http://localhost:3000') ? route.continue() : route.abort(),
  );
  await DB.query('delete from invitations where organization_id = $1', [orgId]);
  await DB.query(
    `delete from organization_members where organization_id = $1 and user_id = any($2)`,
    [orgId, [inviteeId, outsiderId]],
  );
  await DB.query("delete from notifications where template = 'member.invited'");
});

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

test('a manager invites a colleague and the link works exactly once', async ({
  page,
  context,
}) => {
  await actAs(page, await userId('owner@demo.local'));
  await page.goto(MEMBERS);
  await expect(page.getByRole('heading', { name: 'دعوة موظف' })).toBeVisible();

  await page.getByLabel('البريد الإلكتروني').fill(INVITEE);
  await page.getByTestId('send-invite').click();

  await expect(page.getByTestId('invite-created')).toBeVisible();
  const link = await page.getByTestId('invite-link').innerText();
  expect(link).toContain('/join/');

  // Only the hash is stored — the token in that link is nowhere in the table.
  const token = link.split('/join/')[1]!.trim();
  const { rows: stored } = await DB.query(
    'select token_hash from invitations where organization_id = $1',
    [orgId],
  );
  expect(stored).toHaveLength(1);
  expect(stored[0].token_hash).not.toBe(token);

  // The email was enqueued, not sent inline, and enqueued idempotently.
  const { rows: queued } = await DB.query(
    "select channel, dedupe_key from notifications where template = 'member.invited'",
  );
  expect(queued).toHaveLength(1);
  expect(queued[0].channel).toBe('email');
  expect(queued[0].dedupe_key).toMatch(/^invitation:/);

  // The invitee follows the link and is told who invited them.
  await context.clearCookies();
  await actAs(page, inviteeId);
  await page.goto(`/join/${token}`);
  await expect(page.getByText('مطعم الحارة الشامية')).toBeVisible();

  await page.getByTestId('accept-invite').click();
  await expect(page).toHaveURL(new RegExp(`/${ORG}`));

  const { rows: member } = await DB.query(
    `select status from organization_members where organization_id = $1 and user_id = $2`,
    [orgId, inviteeId],
  );
  expect(member[0].status).toBe('active');

  // Single use: the same link is refused the second time.
  await page.goto(`/join/${token}`);
  await expect(page.getByTestId('invite-problem')).toBeVisible();
});

test('a forwarded invitation cannot be used by someone else', async ({ page, context }) => {
  await actAs(page, await userId('owner@demo.local'));
  await page.goto(MEMBERS);
  await page.getByLabel('البريد الإلكتروني').fill(INVITEE);
  await page.getByTestId('send-invite').click();
  await expect(page.getByTestId('invite-created')).toBeVisible();
  const token = (await page.getByTestId('invite-link').innerText()).split('/join/')[1]!.trim();

  // Someone else opens the link. The token says which invitation; their
  // session says who they are, and the two do not match.
  await context.clearCookies();
  await actAs(page, outsiderId);
  await page.goto(`/join/${token}`);
  await expect(page.getByTestId('wrong-account')).toBeVisible();
  await expect(page.getByTestId('accept-invite')).toHaveCount(0);

  const { rows } = await DB.query(
    'select count(*)::int as n from organization_members where organization_id = $1 and user_id = $2',
    [orgId, outsiderId],
  );
  expect(rows[0].n).toBe(0);
});

test('an invalid token says so and offers nothing', async ({ page }) => {
  await actAs(page, inviteeId);
  await page.goto('/join/not-a-real-token-at-all');
  await expect(page.getByTestId('invite-problem')).toBeVisible();
  await expect(page.getByTestId('accept-invite')).toHaveCount(0);
});

test('a manager can withdraw an invitation before it is used', async ({ page, context }) => {
  await actAs(page, await userId('owner@demo.local'));
  await page.goto(MEMBERS);
  await page.getByLabel('البريد الإلكتروني').fill(INVITEE);
  await page.getByTestId('send-invite').click();
  await expect(page.getByTestId('invite-created')).toBeVisible();
  const token = (await page.getByTestId('invite-link').innerText()).split('/join/')[1]!.trim();

  await expect(page.getByTestId('invitation-list')).toContainText(INVITEE);
  const { rows } = await DB.query('select id from invitations where organization_id = $1', [orgId]);
  await page.getByTestId(`revoke-${rows[0].id}`).click();
  await expect(page.getByTestId('invitation-list')).toContainText('مسحوبة');

  await context.clearCookies();
  await actAs(page, inviteeId);
  await page.goto(`/join/${token}`);
  await expect(page.getByTestId('invite-problem')).toBeVisible();
});

test('a member without member.manage is offered no invite form', async ({ page }) => {
  await actAs(page, await userId('kitchen@demo.local'));
  await page.goto(MEMBERS);
  await expect(page.getByTestId('send-invite')).toHaveCount(0);
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
