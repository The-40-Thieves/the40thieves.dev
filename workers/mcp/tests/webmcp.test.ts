import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { checkSurfaces, WEBMCP_PATH, WEBMCP_TOOL_NAMES } from '@the40thieves/manifest';
import type { Manifest } from '@the40thieves/schemas';
import { beforeEach, expect, test } from 'vitest';

import { resetDataCache } from '../src/data.ts';
import { createDeps, handleRequest, type Env, type HandlerDeps } from '../src/index.ts';
import { WEBMCP_KILL_SWITCH_KEY, type PageToolsReply } from '../src/webmcp.ts';
import { FakeKv, FakeRateLimiter, fakeContext, fixture, loadedKv } from './fake-kv.ts';

/**
 * P3-S4: `/mcp/webmcp` is what a hub page reads before it registers WebMCP tools: the
 * Worker's own definitions of the page subset, or `enabled: false` while the kill switch is set.
 */
const SITE = 'https://the40thieves.dev';
const URL_ = `${SITE}${WEBMCP_PATH}`;
const manifest = JSON.parse(fixture('manifest.json')) as Manifest;

interface PolicyRule {
  name: string;
  value: string;
  classes: string[];
  path?: string;
}

const policy = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../security/headers.policy.json'), 'utf8'),
) as { headers: PolicyRule[] };
const unscoped = policy.headers.filter(
  (rule) => rule.classes.includes('mcp') && rule.path === undefined,
);

/** The real MCP handler behind the route, with a counter on it. */
function harness(kv: FakeKv = loadedKv(), limit = 100) {
  const env: Env = {
    MCP_KV: kv as unknown as KVNamespace,
    RATE_LIMITER: new FakeRateLimiter(limit),
    SITE,
  };
  const real = createDeps(env);
  let handled = 0;
  const deps: HandlerDeps = {
    now: real.now,
    handler: (request, bindings, ctx) => {
      handled += 1;
      return real.handler(request, bindings, ctx);
    },
  };
  const send = (init: RequestInit & { path?: string } = {}) => {
    const request = new Request(`${SITE}${init.path ?? WEBMCP_PATH}`, init);
    // The runtime always sets Host; Node's Request does not, and the handler checks it.
    request.headers.set('host', 'the40thieves.dev');
    request.headers.set('cf-connecting-ip', '203.0.113.9');
    return handleRequest(request, env, fakeContext(), deps);
  };
  return { send, kv, handled: () => handled };
}

beforeEach(() => {
  resetDataCache();
});

test('the route map constant and the Worker agree on the path', () => {
  expect(URL_).toBe('https://the40thieves.dev/mcp/webmcp');
});

test('GET answers the page subset with the Worker own descriptions and input schemas', async () => {
  const h = harness();
  const response = await h.send();
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  expect(response.headers.get('cache-control')).toBe('public, max-age=60');
  for (const rule of unscoped) expect(response.headers.get(rule.name), rule.name).toBe(rule.value);
  const reply: PageToolsReply = await response.json();
  expect(reply.enabled).toBe(true);
  expect(reply.tools.map((tool) => tool.name)).toEqual([...WEBMCP_TOOL_NAMES]);
  for (const tool of reply.tools) {
    const listed = manifest.mcp.tools.find((entry) => entry.name === tool.name);
    expect(tool.description, tool.name).toBe(listed?.description);
    expect(tool.inputSchema['type'], tool.name).toBe('object');
    expect(Object.keys(tool).sort(), tool.name).toEqual(['description', 'inputSchema', 'name']);
  }
  const search = reply.tools.find((tool) => tool.name === 'search_projects');
  expect(search?.inputSchema['required']).toEqual(['query']);
  expect(
    checkSurfaces(manifest, {
      pages: new Map(),
      llmsTxt: null,
      webmcpServed: reply.tools.map((tool) => tool.name),
    }),
  ).toEqual([]);
  expect(h.handled()).toBe(1);
});

test('the kill switch key in KV turns the page tools off without touching the handler', async () => {
  const h = harness(loadedKv().set(WEBMCP_KILL_SWITCH_KEY, '1'));
  const response = await h.send();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('public, max-age=60');
  expect(await response.json()).toEqual({ enabled: false, tools: [] });
  expect(h.handled()).toBe(0);
  expect(h.kv.reads).toContain('webmcp-disabled');
});

test('an empty kill switch value still counts as set', async () => {
  const h = harness(loadedKv().set(WEBMCP_KILL_SWITCH_KEY, ''));
  expect(await (await h.send()).json()).toEqual({ enabled: false, tools: [] });
});

test('HEAD answers the GET headers with no body', async () => {
  const response = await harness().send({ method: 'HEAD' });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('public, max-age=60');
  expect(await response.text()).toBe('');
});

test('any other method is a 405 that is never cached', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const h = harness();
    const response = await h.send({ method });
    expect(response.status, method).toBe(405);
    expect(response.headers.get('allow'), method).toBe('GET, HEAD');
    expect(response.headers.get('cache-control'), method).toBeNull();
    expect(h.handled(), method).toBe(0);
  }
});

test('while KV has no documents the answer is an uncached 503', async () => {
  const response = await harness(new FakeKv()).send();
  expect(response.status).toBe(503);
  expect(response.headers.get('cache-control')).toBeNull();
  expect(await response.json()).toEqual({ error: 'data not loaded' });
  for (const rule of unscoped) expect(response.headers.get(rule.name), rule.name).toBe(rule.value);
});

test('the path shares the per-IP budget: the request after the limit is a 429', async () => {
  const h = harness(loadedKv(), 2);
  expect((await h.send()).status).toBe(200);
  expect((await h.send()).status).toBe(200);
  const limited = await h.send();
  expect(limited.status).toBe(429);
  expect(limited.headers.get('retry-after')).toBe('60');
  expect(limited.headers.get('cache-control')).toBeNull();
});

test('look-alike paths are not the endpoint', async () => {
  for (const path of ['/mcp/webmcp/', '/mcp/webmcp/x', '/mcp/webmcpx']) {
    const response = await harness().send({ path });
    expect(response.status, path).toBe(404);
  }
});

test('a request the page itself would send (conditional, with cookies) still answers', async () => {
  const response = await harness().send({
    headers: { 'if-none-match': '"abc"', cookie: 'a=b', origin: SITE },
  });
  expect(response.status).toBe(200);
  expect((await response.json<PageToolsReply>()).enabled).toBe(true);
});
