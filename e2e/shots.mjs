import { chromium } from '@playwright/test';
import pg from 'pg';

// Block external hosts: this sandbox has no egress, and a stalled webfont
// request would otherwise hold every page load open.
const blockExternal = async (context) => {
  await context.route('**/*', (route) => {
    const url = route.request().url();
    return url.startsWith('http://localhost:3000') ? route.continue() : route.abort();
  });
};


const pool = new pg.Pool({
  connectionString: 'postgresql://postgres@localhost/localbasic_dev?host=/tmp&port=5433',
});
const uid = async (email) =>
  (await pool.query('select id from auth.users where email=$1', [email])).rows[0].id;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});

const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ar-EG' });
const owner = await uid('owner@demo.local');
await blockExternal(desktop);
await desktop.addCookies([{ name: 'lb_local_user', value: owner, url: 'http://localhost:3000' }]);

const shots = [
  ['dashboard', '/alhara/main'],
  ['orders', '/alhara/main/orders'],
  ['cashier', '/alhara/main/cashier'],
  ['tables', '/alhara/main/tables'],
  ['menu', '/alhara/main/menu'],
  ['reports', '/alhara/main/reports'],
  ['treasury', '/alhara/main/treasury'],
  ['expenses', '/alhara/main/expenses'],
  ['receipts', '/alhara/main/invoices'],
  ['settings-members', '/alhara/main/settings/members'],
  ['settings-roles', '/alhara/main/settings/roles'],
  ['audit', '/alhara/main/settings/audit'],
];

const page = await desktop.newPage();
for (const [name, path] of shots) {
  await page.goto(`http://localhost:3000${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `/tmp/shots/${name}.png`, fullPage: true });
  console.log('shot', name);
}

// Kitchen on a tablet, where it actually lives.
const tablet = await browser.newContext({ viewport: { width: 1024, height: 768 }, locale: 'ar-EG' });
await blockExternal(tablet);
await tablet.addCookies([
  { name: 'lb_local_user', value: await uid('kitchen@demo.local'), url: 'http://localhost:3000' },
]);
const kp = await tablet.newPage();
await kp.goto('http://localhost:3000/alhara/main/kitchen', { waitUntil: 'domcontentloaded' });
await kp.waitForTimeout(400);
await kp.screenshot({ path: '/tmp/shots/kitchen-tablet.png', fullPage: true });
console.log('shot kitchen-tablet');

// Waiter view.
const waiterCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ar-EG' });
await blockExternal(waiterCtx);
await waiterCtx.addCookies([
  { name: 'lb_local_user', value: await uid('waiter@demo.local'), url: 'http://localhost:3000' },
]);
const wp = await waiterCtx.newPage();
await wp.goto('http://localhost:3000/alhara/main/service', { waitUntil: 'domcontentloaded' });
await wp.waitForTimeout(400);
await wp.screenshot({ path: '/tmp/shots/service.png', fullPage: true });
console.log('shot service');

// Guest menu on a phone.
const { rows } = await pool.query(
  `select pl.token from public_links pl join restaurant_tables t on t.public_link_id=pl.id
   where t.name='3' and pl.is_active limit 1`,
);
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ar-EG', isMobile: true, hasTouch: true });
await blockExternal(phone);
const gp = await phone.newPage();
await gp.goto(`http://localhost:3000/p/${rows[0].token}`, { waitUntil: 'domcontentloaded' });
await gp.waitForTimeout(400);
await gp.screenshot({ path: '/tmp/shots/guest-phone.png', fullPage: true });
console.log('shot guest-phone');

// QR print card.
const tid = (await pool.query("select id from restaurant_tables where name='3' limit 1")).rows[0].id;
await page.goto(`http://localhost:3000/alhara/main/tables/${tid}/qr`, { waitUntil: 'domcontentloaded' });
await page.screenshot({ path: '/tmp/shots/qr-card.png', fullPage: true });
console.log('shot qr-card');

await browser.close();
await pool.end();
