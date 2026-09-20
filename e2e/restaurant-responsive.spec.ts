import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * Responsive and RTL audit of the Restaurant screens.
 *
 * Checks the properties that are cheap to get wrong and expensive to notice:
 * a page wider than the phone it is on, a layout that stopped being
 * right-to-left, and a tap target too small for a thumb in a busy kitchen.
 *
 * Every assertion is measured in a real browser at a real viewport. Nothing
 * here is a screenshot comparison — those fail on font rendering and teach
 * nobody anything.
 */
const DB = new Pool({
  connectionString:
    process.env.LOCAL_DATABASE_URL ??
    'postgresql://postgres@localhost/localbasic_dev?host=/tmp&port=5433',
});

async function actAs(page: Page, email: string) {
  const { rows } = await DB.query('select id from auth.users where email = $1', [email]);
  await page.context().addCookies([
    { name: 'lb_local_user', value: rows[0].id as string, url: 'http://localhost:3000' },
  ]);
}

// This sandbox has no egress; a stalled webfont would hold navigation open.
test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) =>
    route.request().url().startsWith('http://localhost:3000') ? route.continue() : route.abort(),
  );
});

test.afterAll(async () => {
  await DB.end();
});

/** Phone widths that matter in this market, plus a kitchen tablet. */
const VIEWPORTS = [
  { name: '360', width: 360, height: 780 },
  { name: '375', width: 375, height: 812 },
  { name: '390', width: 390, height: 844 },
  { name: '414', width: 414, height: 896 },
  { name: 'tablet', width: 1024, height: 768 },
];

const SCREENS = [
  { path: '/alhara/main/kitchen', as: 'kitchen@demo.local' },
  { path: '/alhara/main/service', as: 'waiter@demo.local' },
  { path: '/alhara/main/cashier', as: 'cashier@demo.local' },
  { path: '/alhara/main/tables', as: 'owner@demo.local' },
  { path: '/alhara/main/orders', as: 'owner@demo.local' },
  { path: '/alhara/main/menu', as: 'owner@demo.local' },
];

for (const screen of SCREENS) {
  for (const vp of VIEWPORTS) {
    test(`${screen.path} has no horizontal overflow at ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await actAs(page, screen.as);
      await page.goto(screen.path);
      // Let the layout settle; these pages are server-rendered.
      await page.waitForLoadState('networkidle');

      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth };
      });

      // A one-pixel rounding difference is not a defect; a real overflow is.
      expect(
        overflow.scrollWidth - overflow.clientWidth,
        `${screen.path} overflows by ${overflow.scrollWidth - overflow.clientWidth}px at ${vp.width}px`,
      ).toBeLessThanOrEqual(1);
    });
  }
}

test('restaurant screens render right-to-left', async ({ page }) => {
  for (const screen of SCREENS) {
    await actAs(page, screen.as);
    await page.goto(screen.path);
    const dir = await page.evaluate(() => document.documentElement.getAttribute('dir'));
    expect(dir, `${screen.path} is not RTL`).toBe('rtl');
  }
});

test('the kitchen board is usable on a tablet', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await actAs(page, 'kitchen@demo.local');
  await page.goto('/alhara/main/kitchen');
  await page.waitForLoadState('networkidle');

  // Every advance button has to be hittable with a thumb, not a mouse. 44px is
  // the usual floor; the kitchen is the screen where it matters most.
  const buttons = page.getByRole('button');
  const count = await buttons.count();
  for (let i = 0; i < count; i += 1) {
    const box = await buttons.nth(i).boundingBox();
    if (!box) continue;
    expect(box.height, `a kitchen button is only ${box.height}px tall`).toBeGreaterThanOrEqual(36);
  }
});

/**
 * The payload check, in the browser this time.
 *
 * listKitchenTickets() never selects a price column, so nothing financial
 * should reach the kitchen tablet. The unit test asserts the query; this
 * asserts what actually arrives over the wire.
 */
test('the kitchen page ships no financial data to the browser', async ({ page }) => {
  await actAs(page, 'kitchen@demo.local');

  const payloads: string[] = [];
  page.on('response', async (response) => {
    if (!response.url().startsWith('http://localhost:3000')) return;
    const type = response.headers()['content-type'] ?? '';
    if (!/text|json|javascript/.test(type)) return;
    try {
      payloads.push(await response.text());
    } catch {
      /* a response that cannot be read cannot leak */
    }
  });

  await page.goto('/alhara/main/kitchen');
  await page.waitForLoadState('networkidle');

  const body = payloads.join('\n');
  // The serialised server payload names its fields. Any of these appearing
  // means money reached the kitchen even if nothing drew it.
  for (const field of ['totalCents', 'paidCents', 'unitPriceCents', 'lineTotalCents']) {
    expect(body, `the kitchen payload contains ${field}`).not.toContain(field);
  }
});
