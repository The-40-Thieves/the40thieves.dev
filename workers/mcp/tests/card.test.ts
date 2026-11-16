import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from 'vitest';

import {
  buildServerCard,
  CARD_PROTOCOL_VERSIONS,
  etagMatches,
  SERVER_CARD_MEDIA_TYPE,
  SERVER_CARD_NAME,
  SERVER_CARD_PATH,
  SERVER_CARD_SCHEMA_URL,
} from '../src/card.ts';
import { handleRequest, type Env, type HandlerDeps } from '../src/index.ts';
import { SERVER_VERSION } from '../src/server.ts';
import { FakeKv, FakeRateLimiter, fakeContext } from './fake-kv.ts';

/**
 * P3-S3: the Server Card (SEP-2127) at `<streamable-http-url>/server-card`. Upstream's
 * discovery document asks for the card media type, CORS for browser clients, an hour of caching
 * and ETag revalidation; the header values live in the policy file and are checked from there.
 */
interface PolicyRule {
  name: string;
  value: string;
  classes: string[];
  path?: string;
}

const policy = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../security/headers.policy.json'), 'utf8'),
) as { headers: PolicyRule[] };
const mcpRules = policy.headers.filter((rule) => rule.classes.includes('mcp'));
const unscoped = mcpRules.filter((rule) => rule.path === undefined);
const scoped = mcpRules.filter((rule) => rule.path === SERVER_CARD_PATH);
const cors = scoped.filter((rule) => rule.name.startsWith('Access-Control-'));

const SITE = 'https://the40thieves.dev';
const CARD_URL = `${SITE}${SERVER_CARD_PATH}`;

function harness(site: string = SITE) {
  const limiter = new FakeRateLimiter(100);
  // An empty namespace: the card must not depend on the KV documents.
  const env: Env = {
    MCP_KV: new FakeKv() as unknown as KVNamespace,
    RATE_LIMITER: limiter,
    SITE: site,
  };
  const calls: Request[] = [];
  const deps: HandlerDeps = {
    handler: (request) => {
      calls.push(request);
      return Promise.resolve(new Response('{"ok":true}'));
    },
    now: () => 1_762_300_000_000,
  };
  const send = (request: Request) => handleRequest(request, env, fakeContext(), deps);
  return { limiter, calls, send };
}

function expectHeaders(response: Response, rules: PolicyRule[]): void {
  expect(rules.length).toBeGreaterThan(0);
  for (const rule of rules) expect(response.headers.get(rule.name), rule.name).toBe(rule.value);
}

async function currentEtag(): Promise<string> {
  const etag = (await harness().send(new Request(CARD_URL))).headers.get('etag');
  if (etag === null) throw new Error('the card has no ETag');
  return etag;
}

test('the policy scopes CORS and an hour of caching to the card path', () => {
  expect(Object.fromEntries(scoped.map((rule) => [rule.name, rule.value]))).toEqual({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET',
    'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
    'Access-Control-Expose-Headers': 'ETag',
    'Cache-Control': 'public, max-age=3600',
  });
});

test('GET answers the card with its media type, an ETag and every policy header, with KV empty', async () => {
  const h = harness();
  const response = await h.send(new Request(CARD_URL));
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe(SERVER_CARD_MEDIA_TYPE);
  expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/);
  expectHeaders(response, scoped);
  expectHeaders(response, unscoped);
  expect(await response.json()).toEqual(buildServerCard(SITE));
  expect(h.calls).toHaveLength(0);
});

test('the card is identity, transport and protocol versions, and nothing else', () => {
  const card = buildServerCard(SITE);
  expect(card).toEqual({
    $schema: SERVER_CARD_SCHEMA_URL,
    name: SERVER_CARD_NAME,
    version: SERVER_VERSION,
    description: card.description,
    websiteUrl: 'https://the40thieves.dev/',
    remotes: [
      {
        type: 'streamable-http',
        url: 'https://the40thieves.dev/mcp',
        supportedProtocolVersions: [...CARD_PROTOCOL_VERSIONS],
      },
    ],
  });
  expect(card.description.length).toBeGreaterThan(0);
  expect(card.description.length).toBeLessThanOrEqual(100);
});

test('the endpoint and website follow the configured site', async () => {
  const response = await harness('https://preview.example').send(
    new Request(`https://preview.example${SERVER_CARD_PATH}`),
  );
  const card = await response.json<{ websiteUrl: string; remotes: { url: string }[] }>();
  expect(card.websiteUrl).toBe('https://preview.example/');
  expect(card.remotes[0]?.url).toBe('https://preview.example/mcp');
});

test('HEAD answers the GET headers with no body', async () => {
  const get = await harness().send(new Request(CARD_URL));
  const head = await harness().send(new Request(CARD_URL, { method: 'HEAD' }));
  expect(head.status).toBe(200);
  expect(await head.text()).toBe('');
  for (const name of ['content-type', 'etag', 'cache-control', 'access-control-allow-origin']) {
    expect(head.headers.get(name), name).toBe(get.headers.get(name));
  }
});

test('a matching If-None-Match answers 304 with the validator, cache and CORS headers', async () => {
  const etag = await currentEtag();
  for (const value of [etag, `W/${etag}`, `"0000", W/${etag}`, `"0000",${etag}`, '*']) {
    const response = await harness().send(
      new Request(CARD_URL, { headers: { 'if-none-match': value } }),
    );
    expect(response.status, value).toBe(304);
    expect(await response.text(), value).toBe('');
    expect(response.headers.get('etag'), value).toBe(etag);
    expect(response.headers.get('content-type'), value).toBeNull();
    expectHeaders(response, scoped);
    expectHeaders(response, unscoped);
  }
});

test('a stale If-None-Match answers 200 with the body', async () => {
  for (const value of ['"0000"', 'W/"0000"', '', 'not-a-tag']) {
    const response = await harness().send(
      new Request(CARD_URL, { headers: { 'if-none-match': value } }),
    );
    expect(response.status, value).toBe(200);
    expect(await response.json(), value).toEqual(buildServerCard(SITE));
  }
});

test('etagMatches compares weakly, across a list, and treats * as any', () => {
  expect(etagMatches(null, '"abc"')).toBe(false);
  expect(etagMatches('', '"abc"')).toBe(false);
  expect(etagMatches('"abc"', '"abc"')).toBe(true);
  expect(etagMatches('W/"abc"', '"abc"')).toBe(true);
  expect(etagMatches('"x", "abc"', '"abc"')).toBe(true);
  expect(etagMatches('*', '"abc"')).toBe(true);
  expect(etagMatches('"abcd"', '"abc"')).toBe(false);
  expect(etagMatches('abc', '"abc"')).toBe(false);
});

test('OPTIONS answers a 204 preflight with the CORS headers', async () => {
  const response = await harness().send(
    new Request(CARD_URL, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://client.example',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'if-none-match',
      },
    }),
  );
  expect(response.status).toBe(204);
  expect(await response.text()).toBe('');
  expectHeaders(response, cors);
  expectHeaders(response, unscoped);
});

test('other methods answer 405 with Allow and CORS, and are never cacheable', async () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const h = harness();
    const response = await h.send(new Request(CARD_URL, { method, body: '{}' }));
    expect(response.status, method).toBe(405);
    expect(response.headers.get('allow'), method).toBe('GET, HEAD, OPTIONS');
    expect(response.headers.get('cache-control'), method).toBeNull();
    expect(await response.json(), method).toEqual({ error: 'method not allowed' });
    expectHeaders(response, cors);
    expectHeaders(response, unscoped);
    expect(h.calls, method).toHaveLength(0);
  }
});

test('the card shares the per-IP budget: the 101st request is a 429 with CORS and no cache header', async () => {
  const h = harness();
  const request = () => new Request(CARD_URL, { headers: { 'cf-connecting-ip': '203.0.113.7' } });
  let last: Response | undefined;
  for (let i = 0; i < 100; i++) last = await h.send(request());
  expect(last?.status).toBe(200);
  const limited = await h.send(request());
  expect(limited.status).toBe(429);
  expect(limited.headers.get('retry-after')).toBe('60');
  expect(limited.headers.get('cache-control')).toBeNull();
  expect(await limited.json()).toEqual({ error: 'rate limited' });
  expectHeaders(limited, cors);
  expectHeaders(limited, unscoped);
  expect(h.limiter.counts.get('203.0.113.7')).toBe(101);
});
