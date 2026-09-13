import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3000',
    locale: 'ar-EG',
    launchOptions: { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
