import { expect, test } from 'vitest';

import { boomAllowed } from '../src/lib/healthz-boom.ts';

// `/healthz?boom=1` throws on purpose so the Sentry pipeline can be exercised; without a gate
// anyone could burn the error quota from production. The gate is a Worker secret matched
// against a request header, and no secret means no boom at all.

test('boomAllowed refuses when no token is configured, whatever the request sends', () => {
  expect(boomAllowed('anything', undefined)).toBe(false);
  expect(boomAllowed(null, undefined)).toBe(false);
  expect(boomAllowed('', '')).toBe(false);
});

test('boomAllowed refuses a missing, empty or wrong header', () => {
  expect(boomAllowed(null, 'secret-token')).toBe(false);
  expect(boomAllowed('', 'secret-token')).toBe(false);
  expect(boomAllowed('secret-toke', 'secret-token')).toBe(false);
  expect(boomAllowed('secret-tokeN', 'secret-token')).toBe(false);
  expect(boomAllowed('secret-token-and-more', 'secret-token')).toBe(false);
});

test('boomAllowed accepts exactly the configured token', () => {
  expect(boomAllowed('secret-token', 'secret-token')).toBe(true);
});
