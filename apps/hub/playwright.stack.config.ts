import { defineConfig, devices } from '@playwright/test';

// P3-S5: the page tools in a real browser against the real `/mcp` Worker. There is no
// webServer here: `scripts/conformance.ts --browser` starts the hub and the Worker on one origin
// (`scripts/agent-stack.ts`) and hands that origin over in STACK_URL.
const baseURL = process.env.STACK_URL;
if (!baseURL) {
  throw new Error('STACK_URL is not set. Run `pnpm conformance --local --browser` instead.');
}

export default defineConfig({
  testDir: './e2e-stack',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
