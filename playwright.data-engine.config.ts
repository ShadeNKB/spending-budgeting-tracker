import { defineConfig, devices } from '@playwright/test'

// The data-engine release gate (PR-2): this build and the shipped 0.9.2 side by side on a fake
// relay. `npm run e2e:data` builds both first (scripts/build-mixed.mjs). The specs start the
// relay (4219) and serve each build themselves (4220-4223), so there is no webServer here, and
// they run one at a time: they share those ports. Files are `*.data.ts`, so the main suite
// (playwright.config.ts, `*.spec.ts`) never picks them up.
export default defineConfig({
  testDir: './e2e/data-engine',
  testMatch: /.*\.data\.ts$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // The sync-on Backup states also pass the gate on an iPhone (support/a11y.ts `isPhone`).
    { name: 'mobile', use: { ...devices['iPhone 14'] }, testMatch: /a11y\.data\.ts$/ },
  ],
})
