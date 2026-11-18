import { afterEach, expect, test, vi } from 'vitest';

import { RELAY_HOSTS } from '../src/allowlist.ts';
import { ERROR_CODES } from '../src/handler.ts';
import {
  BASE,
  expectPolicyHeaders,
  fetchRequest,
  harness,
  HOST,
  NOW,
  SECRET,
  session,
  sessionRequest,
  SITE,
} from './fakes.ts';

afterEach(() => {
  vi.resetModules();
});

const EXPOSED = 'content-type, etag, last-modified, retry-after, x-quota-remaining';

function expectCors(response: Response): void {
  expect(response.headers.get('access-control-allow-origin')).toBe(SITE);
  expect(response.headers.get('access-control-expose-headers')).toBe(EXPOSED);
}

async function expectError(response: Response, code: keyof typeof ERROR_CODES): Promise<void> {
  expect(response.status).toBe(ERROR_CODES[code]);
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  expect(await response.json()).toEqual({ error: code });
  expectPolicyHeaders(response);
}

test('the code list has one status per code, not_configured included', () => {
  expect(ERROR_CODES).toEqual({
    origin_not_allowed: 403,
    method_not_allowed: 405,
    bad_target: 400,
    host_not_allowed: 403,
    session_required: 401,
    session_invalid: 401,
    rate_limited: 429,
    quota_reached: 429,
    body_too_large: 413,
    dns_blocked: 502,
    upstream_redirect: 502,
    upstream_too_large: 502,
    upstream_timeout: 504,
    upstream_failed: 502,
    turnstile_failed: 403,
    not_found: 404,
    not_configured: 503,
    paused: 503,
  });
});

test('happy path: a session is minted, then a fetch is relayed and logged once', async () => {
  const h = harness();
  const minted = await h.send(sessionRequest(JSON.stringify({ token: 'good-token' })));
  expect(minted.status).toBe(200);
  expect(minted.headers.get('content-type')).toBe('application/json; charset=utf-8');
  expectPolicyHeaders(minted);
  expectCors(minted);
  const { session: token, expires_at } = await minted.json<{
    session: string;
    expires_at: number;
  }>();
  expect(expires_at).toBe(Math.floor(NOW / 1000) + 3600);

  const response = await h.send(fetchRequest({ session: token }));
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/json');
  expectPolicyHeaders(response);
  expectCors(response);
  expect(await response.text()).toBe('{"models":[]}');
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]?.url).toBe(`https://${HOST}/v1/models`);
  expect(h.calls[0]?.init?.method).toBe('GET');

  await h.settle();
  const fetchLogs = h.logs.filter((entry) => entry.route === 'fetch');
  expect(fetchLogs).toEqual([
    { route: 'fetch', outcome: 'complete', status: 200, host: HOST, bytes: 13, ms: 0 },
  ]);
  expect(h.logs.filter((entry) => entry.route === 'session')).toEqual([
    { route: 'session', outcome: 'minted', status: 200, ms: 0 },
  ]);
});

test('a POST is relayed with its body, and a HEAD as a HEAD', async () => {
  const h = harness();
  const token = await session();
  const posted = await h.send(fetchRequest({ method: 'POST', session: token, body: '{"q":"x"}' }));
  expect(posted.status).toBe(200);
  await posted.text();
  expect(h.calls[0]?.init?.method).toBe('POST');
  expect(await new Response(h.calls[0]?.init?.body).text()).toBe('{"q":"x"}');

  const head = await h.send(fetchRequest({ method: 'HEAD', session: token }));
  expect(head.status).toBe(200);
  expect(h.calls[1]?.init?.method).toBe('HEAD');
  expect(h.calls[1]?.init?.body ?? null).toBeNull();
});

test('a preflight from the site origin answers 204 with the CORS grant', async () => {
  const h = harness();
  const response = await h.send(
    new Request(`${BASE}/v1/fetch`, {
      method: 'OPTIONS',
      headers: {
        origin: SITE,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-relay-target, x-relay-session, authorization',
      },
    }),
  );
  expect(response.status).toBe(204);
  expect(response.headers.get('access-control-allow-origin')).toBe(SITE);
  expect(response.headers.get('access-control-allow-methods')).toBe('GET, HEAD, POST');
  expect(response.headers.get('access-control-allow-headers')).toBe(
    'x-relay-target, x-relay-session, authorization',
  );
  expect(response.headers.get('access-control-max-age')).toBe('600');
  expect(response.headers.get('vary')).toBe('Origin');
  expectPolicyHeaders(response);
  expect(h.calls).toHaveLength(0);
});

test('a preflight to /v1/session allows POST only', async () => {
  const h = harness();
  const response = await h.send(
    new Request(`${BASE}/v1/session`, {
      method: 'OPTIONS',
      headers: { origin: SITE, 'access-control-request-headers': 'content-type' },
    }),
  );
  expect(response.status).toBe(204);
  expect(response.headers.get('access-control-allow-methods')).toBe('POST');
  expect(response.headers.get('access-control-allow-headers')).toBe('content-type');
  expectPolicyHeaders(response);
});

test('a preflight from another origin is refused without a CORS grant', async () => {
  const h = harness();
  const response = await h.send(
    new Request(`${BASE}/v1/fetch`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.test', 'access-control-request-method': 'GET' },
    }),
  );
  expect(response.headers.has('access-control-allow-origin')).toBe(false);
  await expectError(response, 'origin_not_allowed');
});

test('a fetch with no Origin, or a look-alike one, is origin_not_allowed', async () => {
  const h = harness();
  for (const origin of [null, 'https://the40thieves.dev.evil.test', 'http://the40thieves.dev']) {
    const response = await h.send(fetchRequest({ origin, session: await session() }));
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
    await expectError(response, 'origin_not_allowed');
  }
  expect(h.calls).toHaveLength(0);
});

test('PUT is method_not_allowed, with the CORS grant so the page can read it', async () => {
  const h = harness();
  const response = await h.send(fetchRequest({ method: 'PUT', session: await session() }));
  expectCors(response);
  await expectError(response, 'method_not_allowed');
});

test('a missing or malformed target is bad_target', async () => {
  const h = harness();
  for (const target of [null, 'http://example.com/', 'not a url']) {
    await expectError(
      await h.send(fetchRequest({ target, session: await session() })),
      'bad_target',
    );
  }
});

test('a missing session is session_required and an expired one session_invalid', async () => {
  const h = harness();
  const missing = await h.send(fetchRequest());
  expectCors(missing);
  await expectError(missing, 'session_required');

  const expired = await session(NOW - 3_600_000);
  await expectError(await h.send(fetchRequest({ session: expired })), 'session_invalid');
  await expectError(await h.send(fetchRequest({ session: 'v1.9.forged' })), 'session_invalid');
  expect(h.calls).toHaveLength(0);
});

test('the 61st fetch from one IP in a window is rate_limited with Retry-After 60', async () => {
  const h = harness();
  const token = await session();
  for (let i = 0; i < 60; i++) {
    const response = await h.send(fetchRequest({ session: token }));
    expect(response.status).toBe(200);
    await response.text();
  }
  const limited = await h.send(fetchRequest({ session: token }));
  expect(limited.headers.get('retry-after')).toBe('60');
  expectCors(limited);
  await expectError(limited, 'rate_limited');
  expect(h.calls).toHaveLength(60);
  expect(h.limiter.counts.get('203.0.113.7')).toBe(61);
});

test('the sixth session request from one IP is rate_limited', async () => {
  const h = harness();
  for (let i = 0; i < 5; i++) {
    const response = await h.send(sessionRequest(JSON.stringify({ token: 'good-token' })));
    expect(response.status).toBe(200);
  }
  const limited = await h.send(sessionRequest(JSON.stringify({ token: 'good-token' })));
  expect(limited.headers.get('retry-after')).toBe('60');
  await expectError(limited, 'rate_limited');
  expect(h.sessionLimiter.counts.get('203.0.113.7')).toBe(6);
  expect(h.limiter.counts.size).toBe(0);
});

test('a failing Turnstile verifier is turnstile_failed and mints nothing', async () => {
  const seen: (string | null)[][] = [];
  const h = harness({
    verifyTurnstile: (token, ip) => {
      seen.push([token, ip]);
      return Promise.resolve(false);
    },
  });
  const response = await h.send(sessionRequest(JSON.stringify({ token: 'bad-token' })));
  expectCors(response);
  await expectError(response, 'turnstile_failed');
  expect(seen).toEqual([['bad-token', '203.0.113.7']]);
});

test('a session body that is not a token object is turnstile_failed, not a crash', async () => {
  const h = harness();
  for (const body of ['not json', '[]', '{"token":5}', '{}']) {
    await expectError(await h.send(sessionRequest(body)), 'turnstile_failed');
  }
});

test('a session body over 4096 bytes is body_too_large', async () => {
  const h = harness();
  const body = JSON.stringify({ token: 'x'.repeat(4096) });
  await expectError(await h.send(sessionRequest(body)), 'body_too_large');
});

test('a GET to /v1/session is method_not_allowed and from elsewhere origin_not_allowed', async () => {
  const h = harness();
  await expectError(
    await h.send(new Request(`${BASE}/v1/session`, { headers: { origin: SITE } })),
    'method_not_allowed',
  );
  await expectError(
    await h.send(sessionRequest('{"token":"good-token"}', { origin: 'https://evil.test' })),
    'origin_not_allowed',
  );
});

test('healthz answers the host count without an origin check', async () => {
  const h = harness();
  const response = await h.send(new Request(`${BASE}/v1/healthz`));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true,
    hosts: RELAY_HOSTS.size,
    configured: true,
    quota: [],
    paused: false,
  });
  expectPolicyHeaders(response);
});

test('an unknown path is not_found', async () => {
  const h = harness();
  for (const path of ['/', '/v1/nope', '/v1/fetch/extra']) {
    await expectError(await h.send(new Request(`${BASE}${path}`)), 'not_found');
  }
});

test('upstream errors carry their code and the CORS grant', async () => {
  const h = harness({ answer: () => Promise.reject(new TypeError('network down')) });
  const response = await h.send(fetchRequest({ session: await session() }));
  expectCors(response);
  await expectError(response, 'upstream_failed');
  expect(h.logs).toEqual([
    { route: 'fetch', outcome: 'upstream_failed', status: 502, host: HOST, ms: 0 },
  ]);
});

interface Entry {
  default: { fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> };
}

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} };
const limiter = { limit: () => Promise.resolve({ success: true }) };

function env(overrides: Record<string, string | undefined>): Record<string, unknown> {
  return {
    SITE,
    TURNSTILE_HOSTNAMES: 'the40thieves.dev',
    RATE_LIMITER: limiter,
    SESSION_LIMITER: limiter,
    RELAY_SESSION_SECRET: SECRET,
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    ...overrides,
  };
}

test('the entry module exports the default handler and the QuotaCounter class', async () => {
  // workerd reads every named export of the entry module as a handler or a Durable Object class.
  const entry: Record<string, unknown> = await import('../src/index.ts');
  expect(Object.keys(entry)).toEqual(['QuotaCounter', 'default']);
});

for (const [name, value] of [
  ['RELAY_SESSION_SECRET', undefined],
  ['RELAY_SESSION_SECRET', ''],
  ['TURNSTILE_SECRET_KEY', undefined],
  ['TURNSTILE_SECRET_KEY', ''],
] as const) {
  test(`with ${name} ${value === undefined ? 'unset' : 'empty'} every request is not_configured`, async () => {
    const entry = (await import('../src/index.ts')) as unknown as Entry;
    const bindings = env({ [name]: value });
    const response = await entry.default.fetch(
      fetchRequest({ session: await session() }),
      bindings,
      ctx,
    );
    await expectError(response, 'not_configured');
    const health = await entry.default.fetch(new Request(`${BASE}/v1/healthz`), bindings, ctx);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      ok: true,
      hosts: RELAY_HOSTS.size,
      configured: false,
      quota: [],
      paused: false,
    });
    expectPolicyHeaders(health);
  });
}

test('with both secrets set the entry routes to the handler', async () => {
  const entry = (await import('../src/index.ts')) as unknown as Entry;
  const bindings = env({});
  const health = await entry.default.fetch(new Request(`${BASE}/v1/healthz`), bindings, ctx);
  expect(await health.json()).toEqual({
    ok: true,
    hosts: RELAY_HOSTS.size,
    configured: true,
    quota: [],
    paused: false,
  });
  const refused = await entry.default.fetch(
    fetchRequest({ target: 'https://evil.test/' }),
    bindings,
    ctx,
  );
  await expectError(refused, 'host_not_allowed');
});
