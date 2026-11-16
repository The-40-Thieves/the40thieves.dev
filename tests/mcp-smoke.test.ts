import { MCP_TOOL_NAMES, PAGE_PROTOCOL_VERSION, WEBMCP_TOOL_NAMES } from '@the40thieves/manifest';
import { expect, test } from 'vitest';

import {
  type CardExpectation,
  CARD_MEDIA_TYPE,
  cardFailures,
  CATALOG_MEDIA_TYPE,
  discoveryFailures,
  endpointFor,
  pageToolsFailures,
  parseSmokeArgs,
  SAMPLE_CALLS,
} from '../scripts/mcp-smoke.ts';
import {
  buildServerCard,
  CARD_PROTOCOL_VERSIONS,
  SERVER_CARD_MEDIA_TYPE,
} from '../workers/mcp/src/card.ts';
import { SERVER_VERSION } from '../workers/mcp/src/server.ts';

test('--url is required and names the site or the endpoint itself', () => {
  expect(() => parseSmokeArgs([])).toThrow(/--url/);
  expect(parseSmokeArgs(['--url', 'https://the40thieves.dev']).endpoint.href).toBe(
    'https://the40thieves.dev/mcp',
  );
  expect(parseSmokeArgs(['--url', 'https://the40thieves.dev/']).endpoint.href).toBe(
    'https://the40thieves.dev/mcp',
  );
  expect(parseSmokeArgs(['--url', 'https://the40thieves.dev/mcp']).endpoint.href).toBe(
    'https://the40thieves.dev/mcp',
  );
  expect(() => parseSmokeArgs(['--url', 'not a url'])).toThrow(/URL/);
});

test('endpointFor rejects a plain http origin that is not localhost', () => {
  expect(endpointFor('http://localhost:8787').href).toBe('http://localhost:8787/mcp');
  expect(() => endpointFor('http://the40thieves.dev')).toThrow(/https/);
});

test('every manifest tool has one sample call, and nothing else does', () => {
  expect(Object.keys(SAMPLE_CALLS).sort()).toEqual([...MCP_TOOL_NAMES].sort());
});

// P3-S3: the deploy follows the AI Catalog to the Server Card and compares the card with
// what the connected client learned from server/discover.
const ENDPOINT = new URL('https://the40thieves.dev/mcp');
const CARD_URL = 'https://the40thieves.dev/mcp/server-card';
const CATALOG_URL = 'https://the40thieves.dev/.well-known/ai-catalog.json';
const expected: CardExpectation = {
  endpoint: ENDPOINT.href,
  supportedVersions: [...CARD_PROTOCOL_VERSIONS],
  serverVersion: SERVER_VERSION,
};
const card = buildServerCard('https://the40thieves.dev');
const catalog = {
  specVersion: '1.0',
  entries: [{ identifier: 'urn:air:x:mcp:y', type: CARD_MEDIA_TYPE, url: CARD_URL }],
};

interface Reply {
  status?: number;
  type?: string;
  body?: unknown;
  etag?: string | null;
}

/** A fetch over a fixed table; the card answers 304 when If-None-Match carries its ETag. */
function fakeFetch(table: Record<string, Reply>) {
  const seen: { url: string; headers: Headers }[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init?.headers);
    seen.push({ url, headers });
    const reply = table[url];
    if (reply === undefined) return Promise.resolve(new Response('not found', { status: 404 }));
    const out = new Headers();
    if (reply.type !== undefined) out.set('content-type', reply.type);
    if (reply.etag !== null) out.set('etag', reply.etag ?? '"v1"');
    const etag = out.get('etag');
    if (etag !== null && headers.get('if-none-match') === etag && (reply.status ?? 200) === 200) {
      return Promise.resolve(new Response(null, { status: 304, headers: out }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: out }),
    );
  }) as typeof fetch;
  return { fetchImpl, seen };
}

const good = (): Record<string, Reply> => ({
  [CATALOG_URL]: { type: CATALOG_MEDIA_TYPE, body: catalog },
  [CARD_URL]: { type: CARD_MEDIA_TYPE, body: card },
});

/** The good table with one URL answering 404. */
const without = (missing: string): Record<string, Reply> =>
  Object.fromEntries(Object.entries(good()).filter(([url]) => url !== missing));

const steps = (failures: { step: string }[]) => failures.map((failure) => failure.step);
const quiet = () => undefined;

test('the smoke script and the Worker name the same card media type', () => {
  expect(CARD_MEDIA_TYPE).toBe(SERVER_CARD_MEDIA_TYPE);
});

test("cardFailures passes the hub's card against what discover reported", () => {
  expect(cardFailures(card, expected)).toEqual([]);
});

test('cardFailures names what disagrees with the live server', () => {
  expect(steps(cardFailures(null, expected))).toEqual(['server-card']);
  expect(steps(cardFailures({ ...card, remotes: [] }, expected))).toEqual(['server-card remote']);
  expect(steps(cardFailures(card, { ...expected, endpoint: 'https://other.example/mcp' }))).toEqual(
    ['server-card remote'],
  );
  expect(
    steps(cardFailures(card, { ...expected, supportedVersions: ['2026-07-28', '2027-01-01'] })),
  ).toEqual(['server-card versions']);
  expect(steps(cardFailures(card, { ...expected, serverVersion: '9.9.9' }))).toEqual([
    'server-card version',
  ]);
  // A client that learned no server version cannot confirm the card: that is a failure, not a skip.
  expect(steps(cardFailures(card, { ...expected, serverVersion: undefined }))).toEqual([
    'server-card version',
  ]);
});

test('discoveryFailures follows the catalog to the card and revalidates it', async () => {
  const { fetchImpl, seen } = fakeFetch(good());
  expect(await discoveryFailures(ENDPOINT, expected, fetchImpl, quiet)).toEqual([]);
  expect(seen.map((request) => request.url)).toEqual([CATALOG_URL, CARD_URL, CARD_URL]);
  expect(seen[1]?.headers.get('accept')).toBe(CARD_MEDIA_TYPE);
  expect(seen[2]?.headers.get('if-none-match')).toBe('"v1"');
});

test('discoveryFailures reports a catalog that is missing, mistyped or points elsewhere', async () => {
  const run = async (table: Record<string, Reply>) =>
    steps(await discoveryFailures(ENDPOINT, expected, fakeFetch(table).fetchImpl, quiet));
  expect(await run(without(CATALOG_URL))).toEqual(['ai-catalog']);
  expect(await run({ ...good(), [CATALOG_URL]: { type: 'text/html', body: catalog } })).toEqual([
    'ai-catalog',
  ]);
  expect(
    await run({
      ...good(),
      [CATALOG_URL]: { type: CATALOG_MEDIA_TYPE, body: { specVersion: '1.0', entries: [] } },
    }),
  ).toEqual(['ai-catalog']);
  const elsewhere = { ...catalog, entries: [{ ...catalog.entries[0], url: `${CARD_URL}s` }] };
  expect(
    await run({ ...good(), [CATALOG_URL]: { type: CATALOG_MEDIA_TYPE, body: elsewhere } }),
  ).toEqual(['ai-catalog']);
});

test('discoveryFailures reports a card that is missing, mistyped or does not revalidate', async () => {
  const run = async (table: Record<string, Reply>) =>
    steps(await discoveryFailures(ENDPOINT, expected, fakeFetch(table).fetchImpl, quiet));
  expect(await run(without(CARD_URL))).toEqual(['server-card']);
  expect(await run({ ...good(), [CARD_URL]: { type: 'application/json', body: card } })).toEqual([
    'server-card',
  ]);
  expect(
    await run({ ...good(), [CARD_URL]: { type: CARD_MEDIA_TYPE, body: card, etag: null } }),
  ).toEqual(['server-card revalidation']);
  expect(
    await run({
      ...good(),
      [CARD_URL]: { type: CARD_MEDIA_TYPE, body: { ...card, version: '0.0.1' } },
    }),
  ).toEqual(['server-card version']);
});

test('against localhost there is no hub, so the card is fetched without the catalog', async () => {
  const local = new URL('http://localhost:8787/mcp');
  const localCard = buildServerCard('http://localhost:8787');
  const { fetchImpl, seen } = fakeFetch({
    'http://localhost:8787/mcp/server-card': { type: CARD_MEDIA_TYPE, body: localCard },
  });
  expect(
    await discoveryFailures(local, { ...expected, endpoint: local.href }, fetchImpl, quiet),
  ).toEqual([]);
  expect(seen.map((request) => request.url)).not.toContain(
    'http://localhost:8787/.well-known/ai-catalog.json',
  );
});

// P3-S5: the local stack answers on 127.0.0.1 while its documents name the site, so the
// conformance suite passes the site and nothing is skipped.
test('with a site, a local stack is checked against the URLs its documents name', async () => {
  const local = new URL('http://127.0.0.1:8790/mcp');
  const table = (listed: string): Record<string, Reply> => ({
    'http://127.0.0.1:8790/.well-known/ai-catalog.json': {
      type: CATALOG_MEDIA_TYPE,
      body: { ...catalog, entries: [{ ...catalog.entries[0], url: listed }] },
    },
    'http://127.0.0.1:8790/mcp/server-card': { type: CARD_MEDIA_TYPE, body: card },
  });
  const site = 'https://the40thieves.dev';
  const { fetchImpl, seen } = fakeFetch(table(CARD_URL));
  expect(await discoveryFailures(local, expected, fetchImpl, quiet, site)).toEqual([]);
  expect(seen.map((request) => request.url)).toEqual([
    'http://127.0.0.1:8790/.well-known/ai-catalog.json',
    'http://127.0.0.1:8790/mcp/server-card',
    'http://127.0.0.1:8790/mcp/server-card',
  ]);
  // A catalog that lists the address the stack happens to answer on is wrong: it names the site.
  expect(
    steps(
      await discoveryFailures(
        local,
        expected,
        fakeFetch(table('http://127.0.0.1:8790/mcp/server-card')).fetchImpl,
        quiet,
        site,
      ),
    ),
  ).toEqual(['ai-catalog']);
});

// P3-S4: the deploy reads /mcp/webmcp the way a hub page does and makes one page-style call.
const PAGE_TOOLS_URL = 'https://the40thieves.dev/mcp/webmcp';
const definitions = WEBMCP_TOOL_NAMES.map((name) => ({
  name,
  description: 'x',
  inputSchema: { type: 'object' },
}));
const rpcResult = (result: unknown): Reply => ({
  type: 'application/json',
  body: { jsonrpc: '2.0', id: 1, result },
});
const pageTable = (overrides: Record<string, Reply> = {}): Record<string, Reply> => ({
  [PAGE_TOOLS_URL]: { type: 'application/json', body: { enabled: true, tools: definitions } },
  [ENDPOINT.href]: rpcResult({ content: [{ type: 'text', text: '{"results":[]}' }] }),
  ...overrides,
});

/** A fetch over the good page table with one URL answering `reply`, or 404 when undefined. */
const pageFetch = (url: string, reply: Reply | undefined) =>
  fakeFetch(
    reply === undefined
      ? Object.fromEntries(Object.entries(pageTable()).filter(([key]) => key !== url))
      : pageTable({ [url]: reply }),
  ).fetchImpl;

test('pageToolsFailures reads the page subset and makes the call a page makes', async () => {
  const { fetchImpl, seen } = fakeFetch(pageTable());
  expect(await pageToolsFailures(ENDPOINT, fetchImpl, quiet)).toEqual([]);
  expect(seen.map((request) => request.url)).toEqual([PAGE_TOOLS_URL, ENDPOINT.href]);
  const call = seen[1]?.headers;
  expect(call?.get('mcp-protocol-version')).toBe(PAGE_PROTOCOL_VERSION);
  expect(call?.get('mcp-method')).toBe('tools/call');
  expect(call?.get('mcp-name')).toBe('search_projects');
  // A browser sends the site as Origin on a same-origin POST; the Worker must accept it.
  expect(call?.get('origin')).toBe('https://the40thieves.dev');
});

test('pageToolsFailures passes with the kill switch on, says so and makes no call', async () => {
  const lines: string[] = [];
  const { fetchImpl, seen } = fakeFetch(
    pageTable({
      [PAGE_TOOLS_URL]: { type: 'application/json', body: { enabled: false, tools: [] } },
    }),
  );
  expect(await pageToolsFailures(ENDPOINT, fetchImpl, (line) => lines.push(line))).toEqual([]);
  expect(lines.join('\n')).toMatch(/kill switch is on/);
  expect(seen.map((request) => request.url)).toEqual([PAGE_TOOLS_URL]);
});

test('pageToolsFailures reports an endpoint that is missing, malformed or lists the wrong tools', async () => {
  const run = async (reply: Reply | undefined) =>
    steps(await pageToolsFailures(ENDPOINT, pageFetch(PAGE_TOOLS_URL, reply), quiet));
  const body = (value: unknown): Reply => ({ type: 'application/json', body: value });
  expect(await run(undefined)).toEqual(['page tools']);
  expect(await run(body({ enabled: 'yes', tools: definitions }))).toEqual(['page tools']);
  expect(await run(body({ enabled: true }))).toEqual(['page tools']);
  expect(await run(body({ enabled: false, tools: definitions }))).toEqual(['page tools']);
  expect(await run(body({ enabled: true, tools: definitions.slice(1) }))).toEqual(['page tools']);
  expect(
    await run(
      body({
        enabled: true,
        tools: [...definitions, { name: 'compare_projects', description: 'x', inputSchema: {} }],
      }),
    ),
  ).toEqual(['page tools']);
  expect(await run({ status: 503, type: 'application/json', body: { error: 'x' } })).toEqual([
    'page tools',
  ]);
});

test('pageToolsFailures reports a page-style call that fails', async () => {
  const run = async (reply: Reply | undefined) =>
    steps(await pageToolsFailures(ENDPOINT, pageFetch(ENDPOINT.href, reply), quiet));
  expect(await run(undefined)).toEqual(['page tools call']);
  expect(await run(rpcResult({ content: [{ type: 'text', text: 'no' }], isError: true }))).toEqual([
    'page tools call',
  ]);
  expect(
    await run({
      type: 'application/json',
      body: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' } },
    }),
  ).toEqual(['page tools call']);
  // The legacy lane's SSE framing is exactly what a page cannot read.
  expect(await run({ type: 'text/event-stream', body: { result: { content: [] } } })).toEqual([
    'page tools call',
  ]);
  expect(await run({ status: 429, type: 'application/json', body: { error: 'x' } })).toEqual([
    'page tools call',
  ]);
});
