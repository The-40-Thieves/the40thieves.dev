import { expect, test } from 'vitest';

import { createTurnstileVerifier } from '../src/turnstile.ts';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const hostnames: ReadonlySet<string> = new Set(['the40thieves.dev']);

/** A fake siteverify endpoint that records every call. */
function fakeSiteverify(reply: { body: string; status: number } | 'throw') {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    if (reply === 'throw') return Promise.reject(new Error('network down'));
    return Promise.resolve(new Response(reply.body, { status: reply.status }));
  }) as typeof fetch;
  return { fetchFn, calls };
}

function json(body: unknown, status = 200) {
  return { body: JSON.stringify(body), status };
}

function verifier(
  reply: { body: string; status: number } | 'throw',
  set: ReadonlySet<string> = hostnames,
) {
  const fake = fakeSiteverify(reply);
  return {
    ...fake,
    verify: createTurnstileVerifier({ fetch: fake.fetchFn, secret: 'sekret', hostnames: set }),
  };
}

test('success on an allowed hostname gives true', async () => {
  const { verify } = verifier(json({ success: true, hostname: 'the40thieves.dev' }));
  expect(await verify('tok', '203.0.113.9')).toBe(true);
});

test('success on a hostname outside the set gives false', async () => {
  const { verify } = verifier(json({ success: true, hostname: 'evil.test' }));
  expect(await verify('tok', null)).toBe(false);
});

test('success with no hostname gives false', async () => {
  const { verify } = verifier(json({ success: true }));
  expect(await verify('tok', null)).toBe(false);
});

test('success false gives false', async () => {
  const { verify } = verifier(json({ success: false }));
  expect(await verify('tok', null)).toBe(false);
});

test('a non-boolean success gives false', async () => {
  const { verify } = verifier(json({ success: 'true', hostname: 'the40thieves.dev' }));
  expect(await verify('tok', null)).toBe(false);
});

test('a thrown fetch gives false without throwing', async () => {
  const { verify } = verifier('throw');
  expect(await verify('tok', null)).toBe(false);
});

test('a non-200 gives false', async () => {
  const { verify } = verifier(json({ success: true, hostname: 'the40thieves.dev' }, 500));
  expect(await verify('tok', null)).toBe(false);
});

test('a body that is not JSON gives false', async () => {
  const { verify } = verifier({ body: '<html>', status: 200 });
  expect(await verify('tok', null)).toBe(false);
});

test('a body that is not an object gives false', async () => {
  const { verify } = verifier(json(null));
  expect(await verify('tok', null)).toBe(false);
});

test('an empty token gives false without a fetch', async () => {
  const { verify, calls } = verifier(json({ success: true, hostname: 'the40thieves.dev' }));
  expect(await verify('', null)).toBe(false);
  expect(calls).toHaveLength(0);
});

test('a token over 2048 characters gives false without a fetch', async () => {
  const { verify, calls } = verifier(json({ success: true, hostname: 'the40thieves.dev' }));
  expect(await verify('a'.repeat(2049), null)).toBe(false);
  expect(calls).toHaveLength(0);
});

test('a token of exactly 2048 characters is sent', async () => {
  const { verify, calls } = verifier(json({ success: true, hostname: 'the40thieves.dev' }));
  expect(await verify('a'.repeat(2048), null)).toBe(true);
  expect(calls).toHaveLength(1);
});

test('the request is a form POST to siteverify with secret, response and remoteip', async () => {
  const { verify, calls } = verifier(json({ success: true, hostname: 'the40thieves.dev' }));
  await verify('tok-1', '203.0.113.9');
  expect(calls).toHaveLength(1);
  const [call] = calls;
  const url = call?.url;
  const init = call?.init;
  expect(url).toBe(SITEVERIFY);
  expect(init?.method).toBe('POST');
  expect(init?.redirect).toBe('manual');
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  expect(init?.body).toBeInstanceOf(URLSearchParams);
  const body = init?.body as URLSearchParams;
  expect(body.get('secret')).toBe('sekret');
  expect(body.get('response')).toBe('tok-1');
  expect(body.get('remoteip')).toBe('203.0.113.9');
});

test('remoteip is omitted when the ip is null', async () => {
  const { verify, calls } = verifier(json({ success: true, hostname: 'the40thieves.dev' }));
  await verify('tok-1', null);
  const body = calls[0]?.init?.body as URLSearchParams;
  expect(body.has('remoteip')).toBe(false);
});

test('with example.com in the set the test-key answer passes', async () => {
  const { verify } = verifier(
    json({ success: true, hostname: 'example.com' }),
    new Set(['the40thieves.dev', 'example.com']),
  );
  expect(await verify('XXXX.DUMMY.TOKEN.XXXX', null)).toBe(true);
});

test('the secret never appears in a thrown-fetch outcome', async () => {
  const { verify } = verifier('throw');
  await expect(verify('tok', null)).resolves.toBe(false);
});
