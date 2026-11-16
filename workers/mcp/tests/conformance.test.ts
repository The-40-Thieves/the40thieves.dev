import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as ClientV1 } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as TransportV1 } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { checkSurfaces, MCP_TOOL_NAMES } from '@the40thieves/manifest';
import type { Manifest } from '@the40thieves/schemas';
import { afterAll, beforeAll, expect, test } from 'vitest';

import {
  legacyClientRows,
  originRows,
  rateLimitRows,
  versionHeaderRows,
} from '../../../scripts/lib/conformance-checks.ts';
import { CATALOG_MEDIA_TYPE, discoveryFailures, smoke } from '../../../scripts/mcp-smoke.ts';
import { SERVER_CARD_PATH, type ServerCard } from '../src/card.ts';
import { resetDataCache } from '../src/data.ts';
import { SERVER_VERSION } from '../src/server.ts';
import { inProcessFetch, SITE, testEnv } from './client.ts';
import { FakeRateLimiter, fixture } from './fake-kv.ts';

/**
 * MCP conformance: the Worker serves the 2026-07-28 revision to a modern client
 * and the 2025-11-25 handshake to a legacy one, lists exactly the manifest's tools on both, and
 * answers every tool under the page cap. The smoke script the deploy runs is the same check.
 */
const manifest = JSON.parse(fixture('manifest.json')) as Manifest;
const env = testEnv();
const fetchImpl = inProcessFetch(env);
const endpoint = new URL(`${SITE}/mcp`);

let modern: Client;

beforeAll(async () => {
  resetDataCache();
  modern = new Client(
    { name: 'conformance', version: '0.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  await modern.connect(new StreamableHTTPClientTransport(endpoint, { fetch: fetchImpl }));
});

afterAll(async () => {
  await modern.close();
});

test('server/discover offers 2026-07-28 with the hub as server info', async () => {
  const discovered = await modern.discover();
  expect(discovered.supportedVersions).toEqual(['2026-07-28']);
  expect(discovered.capabilities.tools).toBeDefined();
});

test('the server card agrees with server/discover on versions and the endpoint', async () => {
  const discovered = await modern.discover();
  const response = await fetchImpl(`${SITE}${SERVER_CARD_PATH}`);
  expect(response.status).toBe(200);
  const card = await response.json<ServerCard>();
  expect(card.remotes).toHaveLength(1);
  expect(card.remotes[0]?.url).toBe(endpoint.href);
  expect(card.remotes[0]?.supportedProtocolVersions).toEqual(discovered.supportedVersions);
  // The version the server reports at runtime, as the connected client holds it.
  expect(modern.getServerVersion()?.version).toBe(SERVER_VERSION);
  expect(card.version).toBe(modern.getServerVersion()?.version);
});

test('the deploy discovery check passes: committed catalog, served card, server/discover', async () => {
  const discovered = await modern.discover();
  const catalog = readFileSync(
    resolve(import.meta.dirname, '../../../apps/hub/public/.well-known/ai-catalog.json'),
    'utf8',
  );
  // The hub serves the catalog as a static file; everything under /mcp is the Worker.
  const both = ((url: string | URL, init?: RequestInit) =>
    new URL(String(url)).pathname === '/.well-known/ai-catalog.json'
      ? Promise.resolve(new Response(catalog, { headers: { 'content-type': CATALOG_MEDIA_TYPE } }))
      : fetchImpl(url, init)) as typeof fetch;
  const failures = await discoveryFailures(
    endpoint,
    {
      endpoint: endpoint.href,
      supportedVersions: discovered.supportedVersions,
      serverVersion: modern.getServerVersion()?.version,
    },
    both,
    () => undefined,
  );
  expect(failures).toEqual([]);
});

test('tools/list is the manifest list and the mcp surface has nothing to report', async () => {
  const { tools } = await modern.listTools();
  const names = tools.map((tool) => tool.name);
  expect(names).toEqual([...MCP_TOOL_NAMES]);
  expect(checkSurfaces(manifest, { pages: new Map(), llmsTxt: null, mcpTools: names })).toEqual([]);
});

test('the smoke script passes against the Worker: one call per tool, each under 20 kB', async () => {
  const lines: string[] = [];
  const failures = await smoke(modern, (line) => {
    lines.push(line);
  });
  expect(failures).toEqual([]);
  expect(lines.filter((line) => line.startsWith('ok ')).length).toBeGreaterThanOrEqual(
    MCP_TOOL_NAMES.length,
  );
});

// P3-S5: the checks the CI job runs against local workerd, here against the Worker code
// itself, so a behaviour change shows up in the unit run before the stack is ever started.
test('the conformance checks hold: version header, origin, rate limit, SDK v1', async () => {
  const limited = { ...testEnv(), RATE_LIMITER: new FakeRateLimiter(100) };
  const rows = [
    ...(await versionHeaderRows(endpoint, fetchImpl as typeof fetch)),
    ...(await originRows(endpoint, SITE, fetchImpl as typeof fetch)),
    ...(await legacyClientRows(endpoint, fetchImpl as typeof fetch)),
    ...(await rateLimitRows(
      endpoint,
      { local: true, key: '2001:db8::a', otherKey: '2001:db8::b', retryKey: '2001:db8::c' },
      inProcessFetch(limited) as typeof fetch,
    )),
  ];
  expect(rows.filter((row) => row.status !== 'pass')).toEqual([]);
  expect(rows.map((row) => `${row.group}: ${row.check}`)).toEqual([
    'version header: matching',
    'version header: absent',
    'version header: mismatch',
    'origin: foreign',
    'origin: site',
    'legacy client: connect',
    'legacy client: tools/list',
    'legacy client: tools/call',
    'rate limit: budget',
    'rate limit: refusal',
    'rate limit: per client',
    'rate limit: healthz',
  ]);
});

test('a 2025-11-25 client (SDK v1) connects through the legacy lane and calls a tool', async () => {
  const legacy = new ClientV1({ name: 'conformance-v1', version: '0.0.0' });
  await legacy.connect(new TransportV1(endpoint, { fetch: fetchImpl }));
  try {
    expect(legacy.getServerVersion()?.name).toBe('the40thieves.dev');
    const { tools } = await legacy.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES]);
    const reply = (await legacy.callTool({
      name: 'search_projects',
      arguments: { query: 'calculator' },
    })) as { isError?: boolean; structuredContent?: { results: { slug: string }[] } };
    expect(reply.isError).toBeFalsy();
    expect(reply.structuredContent?.results[0]?.slug).toBe('codecalc');
  } finally {
    await legacy.close();
  }
});
