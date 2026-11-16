import { defineConfig, devices } from '@playwright/test';

// Runs against the built site served by wrangler dev (the same Worker and assets config that
// deploys), so prerendered pages, 404 handling and headers are the production ones.
const port = Number(process.env.E2E_PORT ?? '8787');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${String(port)}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // The boom token is a Worker secret in production; here it is a plain var for the spec. The
    // DSN is blanked so the boom spec never reports to the production Sentry project: wrangler
    // dev otherwise runs with the real SENTRY_DSN from wrangler.jsonc.
    command: `pnpm exec wrangler dev --port ${String(port)} --ip 127.0.0.1 --var HEALTHZ_BOOM_TOKEN:e2e-boom --var SENTRY_DSN:`,
    url: `http://127.0.0.1:${String(port)}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
