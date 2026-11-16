import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, expect, test } from 'vitest';

import { resetDataCache } from '../src/data.ts';
import { createDeps, handleRequest, type Env, type HandlerDeps } from '../src/index.ts';
import { FakeKv, FakeRateLimiter, fakeContext, fixture, loadedKv } from './fake-kv.ts';

interface PolicyRule {
  name: string;
  value: string;
  classes: string[];
  path?: string;
}

const policy = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../security/headers.policy.json'), 'utf8'),
) as { headers: PolicyRule[] };
// Unscoped rules reach every response; path-scoped ones (the server card) have their own tests.
const mcpRules = policy.headers.filter(
  (rule) => rule.classes.includes('mcp') && rule.path === undefined,
);

const SITE = 'https://the40thieves.dev';

function harness(kv: FakeKv = loadedKv()) {
  const limiter = new FakeRateLimiter(100);
  const env: Env = {
    MCP_KV: kv as unknown as KVNamespace,
    RATE_LIMITER: limiter,
    SITE,
  };
  const calls: Request[] = [];
  const deps: HandlerDeps = {
    handler: (request) => {
      calls.push(request);
      return Promise.resolve(
        new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
      );
    },
    now: () => 1_762_300_000_000,
  };
  const send = (request: Request) => handleRequest(request, env, fakeContext(), deps);
  return { env, deps, limiter, calls, send };
}

function mcpPost(ip: string | null, extra: Record<string, string> = {}): Request {
  // The runtime always sets Host; Node's Request does not, and the handler checks it.
  const headers: Record<string, string> = {
    host: 'the40thieves.dev',
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...extra,
  };
  if (ip !== null) headers['cf-connecting-ip'] = ip;
  return new Request(`${SITE}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    }),
  });
}

function expectPolicyHeaders(response: Response): void {
  expect(mcpRules.length).toBeGreaterThan(0);
  for (const rule of mcpRules) {
    expect(response.headers.get(rule.name), rule.name).toBe(rule.value);
  }
}

beforeEach(() => {
  resetDataCache();
});

test('the entry module exports only functions beside the default handler', async () => {
  // workerd reads every named export of the entry module as a handler and refuses to start on
  // any other value ("Incorrect type for map entry"), which is how `wrangler dev` fails.
  const entry: Record<string, unknown> = await import('../src/index.ts');
  const others = Object.entries(entry)
    .filter(([name, value]) => name !== 'default' && typeof value !== 'function')
    .map(([name]) => name);
  expect(others).toEqual([]);
});

test('healthz answers 200 with the manifest build time and the mcp policy headers', async () => {
  const h = harness();
  const response = await h.send(new Request(`${SITE}/mcp/healthz`));
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  const manifest = JSON.parse(fixture('manifest.json')) as { generated_at: string };
  expect(await response.json()).toEqual({ ok: true, generated_at: manifest.generated_at });
  expectPolicyHeaders(response);
  expect(h.calls).toHaveLength(0);
});

test('healthz answers 503 while KV has no manifest, so the deploy loop keeps waiting', async () => {
  const h = harness(new FakeKv());
  const response = await h.send(new Request(`${SITE}/mcp/healthz`));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ ok: false, error: 'data not loaded' });
  expectPolicyHeaders(response);
});

test('the 100th request from one IP reaches the handler and the 101st is a 429', async () => {
  const h = harness();
  let last: Response | undefined;
  for (let i = 0; i < 100; i++) last = await h.send(mcpPost('203.0.113.7'));
  expect(last?.status).toBe(200);
  expect(h.calls).toHaveLength(100);
  const limited = await h.send(mcpPost('203.0.113.7'));
  expect(limited.status).toBe(429);
  expect(limited.headers.get('retry-after')).toBe('60');
  expect(await limited.json()).toEqual({ error: 'rate limited' });
  expectPolicyHeaders(limited);
  expect(h.calls).toHaveLength(100);
  // Another IP has its own budget.
  expect((await h.send(mcpPost('203.0.113.8'))).status).toBe(200);
  expect(h.limiter.counts.get('203.0.113.7')).toBe(101);
});

test('a request with no cf-connecting-ip is still counted, under the key "unknown"', async () => {
  const h = harness();
  for (let i = 0; i < 100; i++) await h.send(mcpPost(null));
  const limited = await h.send(mcpPost(null));
  expect(limited.status).toBe(429);
  expect(h.limiter.counts.get('unknown')).toBe(101);
  expect(h.calls).toHaveLength(100);
});

test('healthz is not rate limited', async () => {
  const h = harness();
  for (let i = 0; i < 101; i++) await h.send(mcpPost('203.0.113.7'));
  const response = await h.send(
    new Request(`${SITE}/mcp/healthz`, { headers: { 'cf-connecting-ip': '203.0.113.7' } }),
  );
  expect(response.status).toBe(200);
  expect(h.limiter.counts.get('203.0.113.7')).toBe(101);
});

test('handler responses carry the mcp policy headers', async () => {
  const h = harness();
  const response = await h.send(mcpPost('203.0.113.7'));
  expect(response.status).toBe(200);
  expectPolicyHeaders(response);
  expect(await response.json()).toEqual({ ok: true });
});

test('anything else under /mcp is a 404', async () => {
  const h = harness();
  for (const path of [
    '/mcp/other',
    '/mcp/',
    '/',
    '/mcp/healthz/x',
    '/mcp/server-card/',
    '/mcp/server-card/x',
    '/mcp/server-cards',
  ]) {
    const response = await h.send(new Request(`${SITE}${path}`));
    expect(response.status, path).toBe(404);
    expect(await response.json()).toEqual({ error: 'not found' });
    expectPolicyHeaders(response);
  }
  expect(h.calls).toHaveLength(0);
});

test('the real handler refuses a browser Origin that is not the site', async () => {
  const h = harness();
  const deps = createDeps(h.env);
  const response = await handleRequest(
    mcpPost('203.0.113.7', { origin: 'https://evil.example' }),
    h.env,
    fakeContext(),
    deps,
  );
  expect(response.status).toBe(403);
  const body = await response.json<{ error: { message: string } }>();
  expect(body.error.message).toBe('Invalid Origin: evil.example');
  expectPolicyHeaders(response);
});

test('the real handler refuses a Host that is not the site', async () => {
  const h = harness();
  const deps = createDeps(h.env);
  const response = await handleRequest(
    mcpPost('203.0.113.7', { host: 'evil.example' }),
    h.env,
    fakeContext(),
    deps,
  );
  expect(response.status).toBe(403);
  const body = await response.json<{ error: { message: string } }>();
  expect(body.error.message).toBe('Invalid Host: evil.example');
});

test('the real handler answers a legacy initialize from a client with no Origin', async () => {
  const h = harness();
  const deps = createDeps(h.env);
  const response = await handleRequest(mcpPost('203.0.113.7'), h.env, fakeContext(), deps);
  expect(response.status).toBe(200);
  // The legacy lane streams one SSE event for the initialize result.
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const data = (await response.text()).split('\n').find((line) => line.startsWith('data: '));
  const body = JSON.parse(data?.slice('data: '.length) ?? '{}') as {
    result: { protocolVersion: string; serverInfo: { name: string } };
  };
  expect(body.result.protocolVersion).toBe('2025-11-25');
  expect(body.result.serverInfo.name).toBe('the40thieves.dev');
  expectPolicyHeaders(response);
});
