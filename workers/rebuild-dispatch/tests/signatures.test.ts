import { expect, test } from 'vitest';

import {
  SANITY_WINDOW_MS,
  signGitHub,
  signSanity,
  verifyGitHubSignature,
  verifySanitySignature,
} from '../src/signatures.ts';

const secret = 'correct horse battery staple';
const body = '{"action":"published","release":{"tag_name":"v0.13.0"}}';

test('a GitHub X-Hub-Signature-256 over the raw body verifies, and nothing else does', async () => {
  const header = await signGitHub(secret, body);
  expect(header).toMatch(/^sha256=[0-9a-f]{64}$/);
  expect(await verifyGitHubSignature(secret, body, header)).toBe(true);
  expect(await verifyGitHubSignature('other secret', body, header)).toBe(false);
  expect(await verifyGitHubSignature(secret, `${body} `, header)).toBe(false);
  expect(await verifyGitHubSignature(secret, body, null)).toBe(false);
  expect(await verifyGitHubSignature(secret, body, 'sha256=abc')).toBe(false);
  expect(await verifyGitHubSignature(secret, body, header.replace('sha256=', 'sha1='))).toBe(false);
});

test('a Sanity signature is t=<ms>,v1=<base64url hmac of "<ms>.<body>"> inside a five-minute window', async () => {
  const now = 1_762_300_000_000;
  const header = await signSanity(secret, body, now - 1000);
  expect(header).toMatch(/^t=\d+,v1=[A-Za-z0-9_-]+$/);
  expect(await verifySanitySignature(secret, body, header, now)).toEqual({ ok: true });
  expect(await verifySanitySignature('other secret', body, header, now)).toEqual({
    ok: false,
    reason: 'invalid',
  });
  expect(await verifySanitySignature(secret, body, header, now + SANITY_WINDOW_MS + 1)).toEqual({
    ok: false,
    reason: 'stale',
  });
  const future = await signSanity(secret, body, now + SANITY_WINDOW_MS + 1);
  expect(await verifySanitySignature(secret, body, future, now)).toEqual({
    ok: false,
    reason: 'stale',
  });
  expect(await verifySanitySignature(secret, body, null, now)).toEqual({
    ok: false,
    reason: 'malformed',
  });
  expect(await verifySanitySignature(secret, body, 'v1=abc', now)).toEqual({
    ok: false,
    reason: 'malformed',
  });
});

test('the Sanity window is five minutes', () => {
  expect(SANITY_WINDOW_MS).toBe(5 * 60 * 1000);
});
