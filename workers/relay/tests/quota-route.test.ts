import { expect, test } from 'vitest';

import { ERROR_CODES, type QuotaDeps, type QuotaMetric } from '../src/handler.ts';
import { memoryQuotaStore, QUOTA_SOURCES } from '../src/quota.ts';
import { MONTHLY_BUDGET_USD, monthlyCost } from './cost-model.ts';
import { BASE, expectPolicyHeaders, fetchRequest, harness, NOW, session, SITE } from './fakes.ts';

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
  return { ...harness({ quota }), metrics, store };
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
