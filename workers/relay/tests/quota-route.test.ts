import { expect, test } from 'vitest';

import { ERROR_CODES, type QuotaDeps, type QuotaMetric } from '../src/handler.ts';
import { memoryQuotaStore, QUOTA_SOURCES } from '../src/quota.ts';
import { MONTHLY_BUDGET_USD, monthlyCost } from './cost-model.ts';
import { RESPONSE_CAP_BYTES } from '../src/forward.ts';
import {
  BASE,
  chunkedBody,
  expectPolicyHeaders,
  fetchRequest,
  harness,
  NOW,
  session,
  SITE,
} from './fakes.ts';

const KEYS = new Map([
  ['courtlistener', 'cl-operator-key'],
  ['guardian', 'gu-operator-key'],
  ['ucdp', 'uc-operator-key'],
]);

const TARGETS: Record<string, string> = {
  courtlistener: 'https://www.courtlistener.com/api/rest/v4/search/?q=habeas',
  guardian: 'https://content.guardianapis.com/search?q=climate&api-key=visitor-key',
  ucdp: 'https://ucdpapi.pcr.uu.se/api/gedevents/25.1?Country=90',
};

function quotaHarness(keys: ReadonlyMap<string, string> = KEYS) {
  const metrics: QuotaMetric[] = [];
  const store = memoryQuotaStore();
  const quota: QuotaDeps = {
    sources: QUOTA_SOURCES,
    keys,
    store,
    metric: (point) => {
      metrics.push(point);
    },
  };
  // A test sets `answer.current` to stand in for the upstream; unset, it is the usual small JSON.
  const answer: { current?: () => Response } = {};
  const upstream = (): Promise<Response> =>
    Promise.resolve(
      answer.current?.() ??
        new Response('{"models":[]}', { headers: { 'content-type': 'application/json' } }),
    );
  return { ...harness({ quota, answer: upstream }), metrics, store, answer };
}

function quotaRequest(
  source: string,
  options: {
    target?: string | null;
    session?: string;
    method?: string;
    ip?: string;
    origin?: string | null;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers: Record<string, string> = {
    'cf-connecting-ip': options.ip ?? '203.0.113.7',
    ...options.headers,
  };
  const origin = options.origin === undefined ? SITE : options.origin;
  if (origin !== null) headers.origin = origin;
  const target = options.target === undefined ? TARGETS[source] : options.target;
  if (target !== undefined && target !== null) headers['x-relay-target'] = target;
  if (options.session !== undefined) headers['x-relay-session'] = options.session;
  return new Request(`${BASE}/v1/quota/${source}`, {
    method: options.method ?? 'GET',
    headers,
  });
}

async function expectError(response: Response, code: keyof typeof ERROR_CODES): Promise<void> {
  expect(response.status).toBe(ERROR_CODES[code]);
  expect(await response.json()).toEqual({ error: code });
  expectPolicyHeaders(response);
}

test('paused: every quota source answers 503 paused before a key, a budget or an upstream', async () => {
  const metrics: QuotaMetric[] = [];
  let storeCalls = 0;
  const store = new Proxy(memoryQuotaStore(), {
    get(target, property, receiver) {
      storeCalls += 1;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  const h = harness({
    paused: () => Promise.resolve(true),
    quota: { sources: QUOTA_SOURCES, keys: KEYS, store, metric: (point) => metrics.push(point) },
  });
  for (const source of KEYS.keys()) {
    const response = await h.send(quotaRequest(source, { session: await session() }));
    await expectError(response, 'paused');
    expect(response.headers.get('retry-after')).toBe('300');
  }
  expect(h.calls).toEqual([]);
  expect(storeCalls).toBe(0);
  expect(metrics).toEqual([]);
  expect(h.limiter.counts.size).toBe(0);
  expect(h.logs.map((entry) => [entry.route, entry.outcome, entry.status])).toEqual(
    [...KEYS.keys()].map(() => ['quota', 'paused', 503]),
  );
});

test('paused comes before the operator key check: a source without a key is paused, not not_configured', async () => {
  const h = harness({
    paused: () => Promise.resolve(true),
    quota: {
      sources: QUOTA_SOURCES,
      keys: new Map(),
      store: memoryQuotaStore(),
      metric: () => undefined,
    },
  });
  await expectError(await h.send(quotaRequest('guardian', { session: await session() })), 'paused');
});

function sentHeaders(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers);
}

test('courtlistener: the operator key goes in Authorization and the visitor one is dropped', async () => {
  const h = quotaHarness();
  const response = await h.send(
    quotaRequest('courtlistener', {
      session: await session(),
      headers: { authorization: 'Token visitor-key' },
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('x-quota-remaining')).toBe('9');
  expect(response.headers.get('access-control-expose-headers')).toContain('x-quota-remaining');
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]?.url).toBe(TARGETS.courtlistener);
  expect(sentHeaders(h.calls[0]?.init).get('authorization')).toBe('Token cl-operator-key');
  await response.arrayBuffer();
  await h.settle();
  expect(h.logs).toEqual([
    expect.objectContaining({ route: 'quota', outcome: 'complete', host: 'www.courtlistener.com' }),
  ]);
  expect(h.metrics).toEqual([{ source: 'courtlistener', outcome: 'complete', status: 200 }]);
});

test('guardian: the operator key replaces the api-key query parameter', async () => {
  const h = quotaHarness();
  const response = await h.send(quotaRequest('guardian', { session: await session() }));
  expect(response.status).toBe(200);
  const url = new URL(h.calls[0]?.url ?? '');
  expect(url.searchParams.getAll('api-key')).toEqual(['gu-operator-key']);
  expect(url.searchParams.get('q')).toBe('climate');
});

test('ucdp: the operator key goes in x-ucdp-access-token, and no Authorization is sent', async () => {
  const h = quotaHarness();
  await h.send(
    quotaRequest('ucdp', {
      session: await session(),
      headers: { 'x-ucdp-access-token': 'visitor', authorization: 'Bearer visitor' },
    }),
  );
  const sent = sentHeaders(h.calls[0]?.init);
  expect(sent.get('x-ucdp-access-token')).toBe('uc-operator-key');
  expect(sent.has('authorization')).toBe(false);
});

test('refusals answer before upstream is called, in check order', async () => {
  const h = quotaHarness();
  const good = await session();
  await expectError(await h.send(quotaRequest('ucdp', { origin: null })), 'origin_not_allowed');
  const post = await h.send(quotaRequest('ucdp', { method: 'POST', session: good }));
  await expectError(post, 'method_not_allowed');
  await expectError(await h.send(quotaRequest('nope', { session: good })), 'not_found');
  await expectError(
    await h.send(quotaRequest('ucdp', { session: good, target: TARGETS.guardian })),
    'host_not_allowed',
  );
  await expectError(await h.send(quotaRequest('ucdp', { target: null })), 'bad_target');
  await expectError(await h.send(quotaRequest('ucdp')), 'session_required');
  await expectError(await h.send(quotaRequest('ucdp', { session: 'v1.1.x' })), 'session_invalid');
  expect(h.calls).toHaveLength(0);
  expect(h.store.tables.size).toBe(0);
});

test('a source without an operator key is not_configured and spends nothing', async () => {
  const h = quotaHarness(new Map([['guardian', 'g']]));
  await expectError(
    await h.send(quotaRequest('ucdp', { session: await session() })),
    'not_configured',
  );
  expect(h.calls).toHaveLength(0);
});

test('without quota deps every quota path is not_configured', async () => {
  const h = harness();
  await expectError(
    await h.send(quotaRequest('ucdp', { session: await session() })),
    'not_configured',
  );
});

test('a visitor over the cap gets quota_reached with Retry-After to UTC midnight', async () => {
  const h = quotaHarness();
  const good = await session();
  for (let i = 0; i < 10; i++) {
    const ok = await h.send(quotaRequest('courtlistener', { session: good }));
    expect(ok.status).toBe(200);
    await ok.body?.cancel();
  }
  const over = await h.send(quotaRequest('courtlistener', { session: good }));
  expect(over.headers.get('retry-after')).toBe(
    String(Math.ceil((86_400_000 - (NOW % 86_400_000)) / 1000)),
  );
  await expectError(over, 'quota_reached');
  expect(h.calls).toHaveLength(10);
  // Another visitor still has a budget.
  const other = await h.send(quotaRequest('courtlistener', { session: good, ip: '198.51.100.9' }));
  expect(other.status).toBe(200);
});

test('a key header named in Connection is still sent', async () => {
  const h = quotaHarness();
  for (const [source, header] of [
    ['courtlistener', 'authorization'],
    ['ucdp', 'x-ucdp-access-token'],
  ] as const) {
    const response = await h.send(
      quotaRequest(source, { session: await session(), headers: { connection: header } }),
    );
    await response.body?.cancel();
    expect(sentHeaders(h.calls.at(-1)?.init).has(header)).toBe(true);
  }
});

test('data points are written only past the session and rate-limit checks', async () => {
  const h = quotaHarness();
  await h.send(quotaRequest('ucdp', { origin: null }));
  await h.send(quotaRequest('ucdp'));
  await h.send(quotaRequest('ucdp', { session: 'v1.1.x' }));
  expect(h.metrics).toEqual([]);
  const relayed = await h.send(quotaRequest('ucdp', { session: await session() }));
  await relayed.arrayBuffer();
  await h.settle();
  expect(h.metrics).toEqual([{ source: 'ucdp', outcome: 'complete', status: 200 }]);
});

test('the preflight allows GET and HEAD only', async () => {
  const h = quotaHarness();
  const response = await h.send(
    new Request(`${BASE}/v1/quota/ucdp`, { method: 'OPTIONS', headers: { origin: SITE } }),
  );
  expect(response.status).toBe(204);
  expect(response.headers.get('access-control-allow-methods')).toBe('GET, HEAD');
});

test('/v1/fetch still refuses a quota host', async () => {
  const h = quotaHarness();
  const response = await h.send(fetchRequest({ session: await session(), target: TARGETS.ucdp }));
  await expectError(response, 'host_not_allowed');
});

test('healthz lists the sources that have an operator key', async () => {
  const h = quotaHarness(
    new Map([
      ['ucdp', 'u'],
      ['guardian', 'g'],
    ]),
  );
  const response = await h.send(new Request(`${BASE}/v1/healthz`));
  expect(await response.json()).toMatchObject({ configured: true, quota: ['guardian', 'ucdp'] });
});

test('a simulated day stays inside every cap and the recorded budget', async () => {
  // 250 visitors, each trying 20 requests on each source (60, inside the per-minute limit):
  // past every site cap, since 250 x 20 is more than even ucdp's 3,600.
  const h = quotaHarness();
  const good = await session();
  let requests = 0;
  for (let visitor = 0; visitor < 250; visitor++) {
    const ip = `10.${String(visitor >> 8)}.${String(visitor & 255)}.1`;
    for (const name of QUOTA_SOURCES.keys()) {
      for (let i = 0; i < 20; i++) {
        const response = await h.send(quotaRequest(name, { session: good, ip }));
        await response.body?.cancel();
        requests++;
      }
    }
  }
  const relayed = new Map<string, number>();
  for (const call of h.calls) {
    const host = new URL(call.url).hostname;
    relayed.set(host, (relayed.get(host) ?? 0) + 1);
  }
  let capTotal = 0;
  for (const source of QUOTA_SOURCES.values()) {
    expect(relayed.get(source.host)).toBe(source.siteCap);
    capTotal += source.siteCap;
  }
  expect(h.calls).toHaveLength(capTotal);
  expect(capTotal).toBe(4060);

  // Every request is one Worker request, at most one counter call and one data point.
  const days = 30;
  const cost = monthlyCost({
    workerRequests: requests * days,
    durableObjectRequests: requests * days,
    analyticsDataPoints: requests * days,
  });
  expect(requests).toBe(15_000);
  expect(cost).toBeLessThanOrEqual(MONTHLY_BUDGET_USD);
}, 120_000);

test('one IPv6 /64 is one visitor: rotating addresses inside it does not multiply the budget', async () => {
  const h = quotaHarness();
  const cap = QUOTA_SOURCES.get('courtlistener')?.visitorCap ?? 0;
  expect(cap).toBeGreaterThan(0);
  const token = await session();
  for (let i = 0; i < cap; i += 1) {
    const ip = `2001:db8:1:2::${(i + 1).toString(16)}`;
    const response = await h.send(quotaRequest('courtlistener', { session: token, ip }));
    expect(response.status, ip).toBe(200);
  }
  await expectError(
    await h.send(quotaRequest('courtlistener', { session: token, ip: '2001:db8:1:2:ffff::1' })),
    'quota_reached',
  );
  // Another /64 is another visitor.
  const other = await h.send(
    quotaRequest('courtlistener', { session: token, ip: '2001:db8:1:3::1' }),
  );
  expect(other.status).toBe(200);
});

test.each([
  [
    'in a JSON error body',
    { body: '{"requested_url":"https://x.test/search?api-key=gu-operator-key"}' },
  ],
  ['in an ETag', { body: '{}', headers: { etag: '"gu-operator-key"' } }],
  [
    'in a rate-limit header',
    { body: '{}', headers: { 'x-ratelimit-note': 'key gu-operator-key' } },
  ],
])('an answer that carries the operator key %s is refused whole', async (_where, upstream) => {
  const h = quotaHarness();
  h.answer.current = () =>
    new Response(upstream.body, {
      status: 400,
      headers: {
        'content-type': 'application/json',
        ...('headers' in upstream ? upstream.headers : {}),
      },
    });
  const response = await h.send(quotaRequest('guardian', { session: await session() }));
  expect(response.status).toBe(ERROR_CODES.upstream_failed);
  const text = await response.text();
  expect(text).toBe('{"error":"upstream_failed"}');
  expect([...response.headers].flat().join(' ')).not.toContain('gu-operator-key');
  expect(h.logs.at(-1)).toMatchObject({ route: 'quota', outcome: 'key_reflected', status: 502 });
  expect(h.metrics.at(-1)).toMatchObject({ source: 'guardian', outcome: 'key_reflected' });
});

// Made-up keys with characters that change under encoding. The echoes are built here, not
// written out, so the file holds no string shaped like a credential in a URL.
test.each([
  ['percent-encoded', 'made/up+value=', (key: string) => encodeURIComponent(key)],
  [
    'percent-encoded in lower case',
    'made/up+value=',
    (key: string) => encodeURIComponent(key).toLowerCase(),
  ],
  [
    'as the query string carries it',
    "made up (value)!~'*",
    (key: string) => new URLSearchParams({ k: key }).toString().slice(2),
  ],
])('an echo of the operator key %s is refused too', async (_how, key, spell) => {
  const echoed = spell(key);
  expect(echoed).not.toBe(key);
  const h = quotaHarness(new Map([['guardian', key]]));
  h.answer.current = () => new Response(JSON.stringify({ sent: echoed }), { status: 400 });
  const response = await h.send(quotaRequest('guardian', { session: await session() }));
  expect(await response.text()).toBe('{"error":"upstream_failed"}');
  // The key did go upstream in the query string, in the spelling the last case echoes.
  expect(h.calls.at(-1)?.url).toContain(new URLSearchParams({ k: key }).toString().slice(2));
});

test('an ordinary answer is passed on whole, with its status and the remaining budget', async () => {
  const h = quotaHarness();
  h.answer.current = () =>
    new Response('{"results":[1,2,3]}', {
      status: 200,
      headers: { 'content-type': 'application/json', etag: '"abc"' },
    });
  const response = await h.send(quotaRequest('guardian', { session: await session() }));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('{"results":[1,2,3]}');
  expect(response.headers.get('etag')).toBe('"abc"');
  expect(response.headers.get('x-quota-remaining')).not.toBeNull();
  expect(h.logs.at(-1)).toMatchObject({
    route: 'quota',
    outcome: 'complete',
    status: 200,
    bytes: 19,
  });
});

test('a quota answer over the cap is a 502, not a cut stream', async () => {
  const h = quotaHarness();
  h.answer.current = () => new Response(chunkedBody(RESPONSE_CAP_BYTES + 1), { status: 200 });
  await expectError(
    await h.send(quotaRequest('guardian', { session: await session() })),
    'upstream_too_large',
  );
});
