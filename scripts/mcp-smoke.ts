import { parseArgs } from 'node:util';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  MCP_TOOL_NAMES,
  pageRpcRequest,
  WEBMCP_PATH,
  WEBMCP_TOOL_NAMES,
} from '@the40thieves/manifest';

import { jsonBytes, MAX_PAGE_BYTES } from '../workers/mcp/src/caps.ts';

/**
 * Live conformance smoke for the `/mcp` Worker (P3-S1): a modern (2026-07-28)
 * client discovers the endpoint, lists the tools, calls each one once and checks the page cap;
 * the AI Catalog is followed to the Server Card, which must agree with that discovery (P3-S3);
 * the page tool subset is read and called the way a hub page does it (P3-S4); a legacy-mode client then lists the same tools through the 2025 handshake. The deploy runs it
 * after every Worker upload; `workers/mcp/tests/conformance.test.ts` runs the same checks
 * in-process.
 */
export const MODERN_PROTOCOL_VERSION = '2026-07-28';

/** One cheap, always-valid call per tool. The slugs and the path exist on the live site. */
export const SAMPLE_CALLS: Readonly<Record<string, Record<string, unknown>>> = {
  search_projects: { query: 'mcp', limit: 5 },
  compare_projects: { slugs: ['codecalc', 'alexandria-mcp'] },
  get_project: { slug: 'codecalc' },
  get_install: { slug: 'codecalc', client: 'shell' },
  latest_release: { slug: 'codecalc' },
  changelog_since: { version: '0.0.0' },
  search_docs: { query: 'install', limit: 3 },
  read_doc: { path: '/AGENTS.md' },
  validate_config: { slug: 'codecalc', client: 'cursor', config: { mcpServers: {} } },
};

export interface SmokeFailure {
  step: string;
  detail: string;
}

type Log = (line: string) => void;

interface ToolReply {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/** Every check against an already-connected modern client; an empty list is a pass. */
export async function smoke(client: Client, log: Log = console.log): Promise<SmokeFailure[]> {
  const failures: SmokeFailure[] = [];
  const fail = (step: string, detail: string) => {
    failures.push({ step, detail });
    log(`FAIL ${step}: ${detail}`);
  };

  const discovered = await client.discover();
  if (discovered.supportedVersions.includes(MODERN_PROTOCOL_VERSION)) {
    log(`ok discover: ${discovered.supportedVersions.join(', ')}`);
  } else {
    fail('discover', `supportedVersions ${JSON.stringify(discovered.supportedVersions)}`);
  }

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  if (JSON.stringify(names) === JSON.stringify(MCP_TOOL_NAMES)) {
    log(`ok tools/list: ${String(names.length)} tools`);
  } else {
    fail('tools/list', `got ${names.join(', ')}; manifest says ${MCP_TOOL_NAMES.join(', ')}`);
  }

  for (const name of MCP_TOOL_NAMES) {
    const args = SAMPLE_CALLS[name];
    if (args === undefined) {
      fail(name, 'no sample call');
      continue;
    }
    let reply: ToolReply;
    try {
      reply = (await client.callTool({ name, arguments: args })) as ToolReply;
    } catch (error) {
      fail(name, error instanceof Error ? error.message : String(error));
      continue;
    }
    if (reply.isError) {
      fail(name, `isError: ${JSON.stringify(reply).slice(0, 200)}`);
      continue;
    }
    if (reply.structuredContent === undefined) {
      fail(name, 'no structuredContent');
      continue;
    }
    const bytes = jsonBytes(reply.structuredContent);
    if (bytes > MAX_PAGE_BYTES) {
      fail(name, `${String(bytes)} bytes of structuredContent, cap is ${String(MAX_PAGE_BYTES)}`);
      continue;
    }
    log(`ok ${name}: ${String(bytes)} bytes`);
  }
  return failures;
}

/**
 * Discovery (P3-S3, SEP-2127): the media types of the AI Catalog and of the Server Card it
 * points at. Spelled out here rather than imported so the deploy runs this file without loading
 * the Worker's sources; `tests/mcp-smoke.test.ts` holds the card type equal to the Worker's.
 */
export const CATALOG_PATH = '/.well-known/ai-catalog.json';
export const CATALOG_MEDIA_TYPE = 'application/ai-catalog+json';
export const CARD_MEDIA_TYPE = 'application/mcp-server-card+json';

/** What the connected client learned at runtime; the card must not contradict it. */
export interface CardExpectation {
  /** The `/mcp` endpoint the client connected to. */
  endpoint: string;
  /** `supportedVersions` from `server/discover`. */
  supportedVersions: string[];
  /** The server version the client reports; `undefined` cannot confirm the card and fails. */
  serverVersion: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Compare a fetched Server Card with the live server; an empty list means they agree. */
export function cardFailures(card: unknown, expected: CardExpectation): SmokeFailure[] {
  if (!isRecord(card)) return [{ step: 'server-card', detail: 'the body is not a JSON object' }];
  const failures: SmokeFailure[] = [];
  const remotes: unknown[] = Array.isArray(card['remotes']) ? card['remotes'] : [];
  const remote = remotes
    .filter(isRecord)
    .find((entry) => entry['type'] === 'streamable-http' && entry['url'] === expected.endpoint);
  if (remote === undefined) {
    failures.push({
      step: 'server-card remote',
      detail: `no streamable-http remote for ${expected.endpoint} in ${JSON.stringify(remotes)}`,
    });
  } else {
    const listed = JSON.stringify(remote['supportedProtocolVersions']);
    if (listed !== JSON.stringify(expected.supportedVersions)) {
      failures.push({
        step: 'server-card versions',
        detail: `card ${listed}, server/discover ${JSON.stringify(expected.supportedVersions)}`,
      });
    }
  }
  if (expected.serverVersion === undefined || card['version'] !== expected.serverVersion) {
    failures.push({
      step: 'server-card version',
      detail: `card ${JSON.stringify(card['version'])}, server ${JSON.stringify(expected.serverVersion)}`,
    });
  }
  return failures;
}

function isLocal(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
}

/** The one Server Card URL the site's AI Catalog lists; throws with the reason otherwise. */
async function catalogCardUrl(origin: string, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(`${origin}${CATALOG_PATH}`);
  if (response.status !== 200)
    throw new Error(`${CATALOG_PATH} answered ${String(response.status)}`);
  const type = response.headers.get('content-type') ?? '';
  if (!type.startsWith(CATALOG_MEDIA_TYPE)) {
    throw new Error(`content-type ${JSON.stringify(type)}, expected ${CATALOG_MEDIA_TYPE}`);
  }
  const catalog: unknown = await response.json();
  const entries: unknown[] =
    isRecord(catalog) && Array.isArray(catalog['entries']) ? catalog['entries'] : [];
  const cards = entries.filter(isRecord).filter((entry) => entry['type'] === CARD_MEDIA_TYPE);
  const url = cards[0]?.['url'];
  if (cards.length !== 1 || typeof url !== 'string') {
    throw new Error(
      `expected one ${CARD_MEDIA_TYPE} entry with a url, found ${String(cards.length)}`,
    );
  }
  return url;
}

/**
 * The path a client that knows only the domain takes: the AI Catalog names the card, the card
 * answers with its media type and agrees with `expected`, and its ETag revalidates to a 304.
 * A localhost endpoint is a Worker without the hub, so the catalog step is skipped there, unless
 * `site` is given: that is the origin the documents name when the hub and the Worker answer
 * somewhere else (the local stack of P3-S5), and then the catalog must list the card there.
 */
export async function discoveryFailures(
  endpoint: URL,
  expected: CardExpectation,
  fetchImpl: typeof fetch = fetch,
  log: Log = console.log,
  site?: string,
): Promise<SmokeFailure[]> {
  const failures: SmokeFailure[] = [];
  const fail = (step: string, detail: string) => {
    failures.push({ step, detail });
    log(`FAIL ${step}: ${detail}`);
  };
  const cardUrl = `${endpoint.href}/server-card`;
  const listedCardUrl = site === undefined ? cardUrl : `${site}${endpoint.pathname}/server-card`;

  if (site === undefined && isLocal(endpoint)) {
    log('skip ai-catalog: a localhost endpoint has no hub in front of it');
  } else {
    try {
      const listed = await catalogCardUrl(endpoint.origin, fetchImpl);
      if (listed === listedCardUrl) log(`ok ai-catalog: ${listed}`);
      else fail('ai-catalog', `lists ${listed}, the card is at ${listedCardUrl}`);
    } catch (error) {
      fail('ai-catalog', error instanceof Error ? error.message : String(error));
    }
    if (failures.length > 0) return failures;
  }

  const response = await fetchImpl(cardUrl, { headers: { accept: CARD_MEDIA_TYPE } });
  const type = response.headers.get('content-type') ?? '';
  if (response.status !== 200 || type !== CARD_MEDIA_TYPE) {
    fail('server-card', `status ${String(response.status)}, content-type ${JSON.stringify(type)}`);
    return failures;
  }
  const disagreements = cardFailures(await response.json(), expected);
  for (const failure of disagreements) fail(failure.step, failure.detail);
  if (disagreements.length === 0) log(`ok server-card: agrees with server/discover`);

  const etag = response.headers.get('etag');
  const again =
    etag === null
      ? null
      : await fetchImpl(cardUrl, { headers: { accept: CARD_MEDIA_TYPE, 'if-none-match': etag } });
  if (again?.status === 304) log(`ok server-card revalidation: 304 for ${String(etag)}`);
  else if (again === null) fail('server-card revalidation', 'the card has no ETag');
  else fail('server-card revalidation', `If-None-Match answered ${String(again.status)}`);
  return failures;
}

/**
 * What a hub page does (P3-S4): read the page tool subset from `/mcp/webmcp`, then make one
 * tool call with the request a browser sends, Origin included, and read a plain JSON body back.
 * A subset turned off by the kill switch is a pass that says so; nothing is called then.
 */
export async function pageToolsFailures(
  endpoint: URL,
  fetchImpl: typeof fetch = fetch,
  log: Log = console.log,
): Promise<SmokeFailure[]> {
  const fail = (step: string, detail: string): SmokeFailure[] => {
    log(`FAIL ${step}: ${detail}`);
    return [{ step, detail }];
  };
  const isJson = (response: Response) =>
    (response.headers.get('content-type') ?? '').startsWith('application/json');

  const listed = await fetchImpl(`${endpoint.origin}${WEBMCP_PATH}`);
  if (listed.status !== 200 || !isJson(listed)) {
    return fail(
      'page tools',
      `status ${String(listed.status)}, content-type ${JSON.stringify(listed.headers.get('content-type'))}`,
    );
  }
  const reply: unknown = await listed.json();
  if (!isRecord(reply) || typeof reply['enabled'] !== 'boolean' || !Array.isArray(reply['tools'])) {
    return fail('page tools', 'the body is not { enabled: boolean, tools: [] }');
  }
  const names = reply['tools']
    .filter(isRecord)
    .map((tool) => String(tool['name']))
    .sort();
  if (!reply['enabled']) {
    if (names.length > 0) return fail('page tools', `disabled, yet it lists ${names.join(', ')}`);
    log('ok page tools: the kill switch is on, no page registers a tool');
    return [];
  }
  const wanted = [...WEBMCP_TOOL_NAMES].sort();
  if (names.length !== reply['tools'].length || names.join(' ') !== wanted.join(' ')) {
    return fail('page tools', `lists ${names.join(', ')}, expected ${wanted.join(', ')}`);
  }
  log(`ok page tools: ${names.join(', ')}`);

  const request = pageRpcRequest('tools/call', {
    name: 'search_projects',
    arguments: SAMPLE_CALLS['search_projects'] ?? {},
  });
  const called = await fetchImpl(endpoint.href, {
    method: 'POST',
    headers: { ...request.headers, origin: endpoint.origin },
    body: request.body,
  });
  if (called.status !== 200 || !isJson(called)) {
    return fail(
      'page tools call',
      `status ${String(called.status)}, content-type ${JSON.stringify(called.headers.get('content-type'))}`,
    );
  }
  const message: unknown = await called.json();
  const result = isRecord(message) ? message['result'] : undefined;
  if (!isRecord(result) || !Array.isArray(result['content'])) {
    return fail('page tools call', `no result: ${JSON.stringify(message).slice(0, 200)}`);
  }
  if (result['isError'] === true) {
    return fail('page tools call', `isError: ${JSON.stringify(result['content']).slice(0, 200)}`);
  }
  log('ok page tools call: search_projects answers a JSON body to a same-origin page request');
  return [];
}

/** The `/mcp` endpoint for a site origin or the endpoint itself; https except on localhost. */
export function endpointFor(base: string): URL {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`--url is not a URL: ${base}`);
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error(`--url must be https (got ${url.protocol}//${url.host})`);
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/mcp') ? path : `${path}/mcp`;
  url.search = '';
  url.hash = '';
  return url;
}

export function parseSmokeArgs(argv: string[]): { endpoint: URL } {
  const { values } = parseArgs({ args: argv, options: { url: { type: 'string' } } });
  if (values.url === undefined) {
    throw new Error('Usage: mcp-smoke --url <https://the40thieves.dev | endpoint>');
  }
  return { endpoint: endpointFor(values.url) };
}

async function main(): Promise<void> {
  const { endpoint } = parseSmokeArgs(process.argv.slice(2));
  console.log(`mcp-smoke: ${endpoint.href}`);

  const modern = new Client(
    { name: 'the40thieves-mcp-smoke', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } },
  );
  await modern.connect(new StreamableHTTPClientTransport(endpoint));
  const failures = await smoke(modern);
  failures.push(
    ...(await discoveryFailures(endpoint, {
      endpoint: endpoint.href,
      supportedVersions: (await modern.discover()).supportedVersions,
      serverVersion: modern.getServerVersion()?.version,
    })),
  );
  await modern.close();
  failures.push(...(await pageToolsFailures(endpoint)));

  // The 2025 handshake: the default mode of this client is the legacy initialize sequence.
  const legacy = new Client({ name: 'the40thieves-mcp-smoke-legacy', version: '1.0.0' });
  try {
    await legacy.connect(new StreamableHTTPClientTransport(endpoint));
    const names = (await legacy.listTools()).tools.map((tool) => tool.name);
    if (JSON.stringify(names) === JSON.stringify(MCP_TOOL_NAMES)) {
      console.log(`ok legacy lane: ${String(names.length)} tools`);
    } else {
      failures.push({ step: 'legacy tools/list', detail: names.join(', ') });
      console.log(`FAIL legacy tools/list: ${names.join(', ')}`);
    }
    await legacy.close();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    failures.push({ step: 'legacy connect', detail });
    console.log(`FAIL legacy connect: ${detail}`);
  }

  if (failures.length > 0) {
    console.error(`${String(failures.length)} mcp-smoke failure(s)`);
    process.exitCode = 1;
  } else {
    console.log('mcp-smoke: no failures');
  }
}

if (import.meta.main) {
  await main();
}
