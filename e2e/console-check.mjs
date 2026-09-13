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

const pool = new pg.Pool({ connectionString: 'postgresql://postgres@localhost/localbasic_dev?host=/tmp&port=5433' });
const uid = async (e) => (await pool.query('select id from auth.users where email=$1',[e])).rows[0].id;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ locale: 'ar-EG' });
await blockExternal(ctx);
await ctx.addCookies([{ name:'lb_local_user', value: await uid('owner@demo.local'), url:'http://localhost:3000' }]);
const page = await ctx.newPage();
const seen = new Set();
page.on('console', m => { if (m.type()==='error') seen.add(m.text().slice(0,300)); });
page.on('pageerror', e => seen.add('PAGEERROR: '+e.message.slice(0,300)));
for (const p of ['/alhara/main','/alhara/main/cashier','/alhara/main/kitchen','/alhara/main/tables','/alhara/main/menu','/alhara/main/orders','/alhara/main/reports','/alhara/main/treasury','/alhara/main/expenses','/alhara/main/invoices','/alhara/main/settings/members','/alhara/main/service']) {
  await page.goto('http://localhost:3000'+p, { waitUntil:'domcontentloaded' });
  await page.waitForTimeout(300);
}
console.log([...seen].join('\n---\n') || 'NO CONSOLE ERRORS');
await browser.close(); await pool.end();
