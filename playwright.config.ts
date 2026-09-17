import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * Where to find Chromium.
 *
 * PLAYWRIGHT_CHROMIUM_PATH wins, for an environment that knows. Otherwise this
 * sandbox's pre-installed browser is used when it is actually there, and
 * everywhere else — CI included — Playwright resolves its own download. The
 * path used to be hardcoded, which made the suite unrunnable outside this
 * container.
 */
const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_PATH ??
  (existsSync(SANDBOX_CHROMIUM) ? SANDBOX_CHROMIUM : undefined);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3000',
    locale: 'ar-EG',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
