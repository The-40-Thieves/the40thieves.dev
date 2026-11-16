import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// The e2e suite runs the built Worker under wrangler dev with the vars from wrangler.jsonc,
// including the production SENTRY_DSN. The command must blank it, or every CI run reports the
// healthz boom spec to the production Sentry project (seen as HUB-1 events from runner IPs).
const config = readFileSync(new URL('../playwright.config.ts', import.meta.url), 'utf8');
const command = /command: `([^`]+)`/.exec(config)?.[1] ?? '';

describe('playwright.config.ts webServer', () => {
  it('starts wrangler dev with an empty SENTRY_DSN so e2e runs never report to Sentry', () => {
    expect(command).toContain('wrangler dev');
    expect(command).toMatch(/--var SENTRY_DSN:(\s|$)/);
  });

  it('hands the spec its boom token as a plain var', () => {
    expect(command).toContain('--var HEALTHZ_BOOM_TOKEN:e2e-boom');
  });
});
