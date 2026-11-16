import { Client as ClientV1 } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as TransportV1 } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  checkSurfaces,
  jsonLdBlocks,
  MCP_TOOL_NAMES,
  PAGE_PROTOCOL_VERSION,
  pageDeclaredTools,
  pageRpcRequest,
  type SurfaceInputs,
  twinPath,
  WEBMCP_PATH,
} from '@the40thieves/manifest';
import { type Manifest, manifestSchema } from '@the40thieves/schemas';

import {
  RATE_LIMIT_PER_PERIOD,
  RATE_LIMIT_PERIOD_SECONDS,
} from '../../workers/mcp/src/ratelimit.ts';
import { SAMPLE_CALLS } from '../mcp-smoke.ts';

/**
 * The checks of the agent-surface conformance suite (P3-S5). Each one reads an answer from
 * a running stack and becomes one row of the report: what was checked, whether it held, and what
 * was seen. `scripts/conformance.ts` runs the groups; nothing here starts or stops anything.
 */
export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface CheckRow {
  /** The surface or behaviour the row belongs to, the heading it sits under in the report. */
  group: string;
  check: string;
  status: CheckStatus;
  /** What was seen: enough to act on a failure without rerunning. */
  detail: string;
}

type Fetch = typeof fetch;

// The detail may span lines (an error message with its cause), so `.` matches a line break too.
const LOG_LINE = /^(ok|FAIL|skip) (.+?): (.*)$/s;
const LOG_STATUS: Record<string, CheckStatus> = { ok: 'pass', FAIL: 'fail', skip: 'skip' };

/** Rows from the `ok step: detail` lines the smoke functions log; other lines are not checks. */
export function rowsFromLog(group: string, lines: readonly string[]): CheckRow[] {
  const rows: CheckRow[] = [];
  for (const line of lines) {
    const match = LOG_LINE.exec(line);
    const status = match === null ? undefined : LOG_STATUS[match[1] ?? ''];
    if (match === null || status === undefined) continue;
    rows.push({ group, check: match[2] ?? '', status, detail: match[3] ?? '' });
  }
  return rows;
}

/** Run one group; a throw (a dropped connection, a body that is not JSON) is one failed row. */
export async function guarded(group: string, run: () => Promise<CheckRow[]>): Promise<CheckRow[]> {
  try {
    return await run();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return [{ group, check: 'ran', status: 'fail', detail }];
  }
}

/**
 * Run one of the smoke functions (`ok step: detail` lines, failures returned) as a group. The
 * lines are the rows. A throw keeps the rows before it and adds a failed one; so does a returned
 * failure that no line reported, and a run that reported nothing at all: a group with no row
 * would drop out of the report and read as a pass.
 */
export async function logged(
  group: string,
  run: (log: (line: string) => void) => Promise<readonly { step: string; detail: string }[]>,
): Promise<CheckRow[]> {
  const lines: string[] = [];
  const failed = (check: string, detail: string): CheckRow => ({
    group,
    check,
    status: 'fail',
    detail,
  });
  let failures: readonly { step: string; detail: string }[];
  try {
    failures = await run((line) => {
      lines.push(line);
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return [...rowsFromLog(group, lines), failed('ran', detail)];
  }
  const rows = rowsFromLog(group, lines);
  if (failures.length > rows.filter((row) => row.status === 'fail').length) {
    const detail = failures.map((failure) => `${failure.step}: ${failure.detail}`).join('; ');
    rows.push(failed('unreported failure', detail));
  }
  if (rows.length === 0) rows.push(failed('ran', 'no check reported a result'));
  return rows;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface Answer {
  status: number;
  /** The parsed JSON body, or `undefined` when there is none or it is not JSON. */
  body: unknown;
}

/**
 * The request a hub page sends (`pageRpcRequest`): `tools/list` as one POST with the
 * 2026-07-28 headers. `headers` overrides them; `null` removes one.
 */
async function pageToolsList(
  endpoint: URL,
  fetchImpl: Fetch,
  headers: Record<string, string | null> = {},
): Promise<Answer> {
  const request = pageRpcRequest('tools/list', {});
  const sent = new Headers(request.headers);
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) sent.delete(name);
    else sent.set(name, value);
  }
  const response = await fetchImpl(endpoint.href, {
    method: 'POST',
    headers: sent,
    body: request.body,
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

/** The tools of a JSON-RPC `tools/list` result, or `null` when the body is not one. */
function listedTools(body: unknown): unknown[] | null {
  const result = isRecord(body) ? body['result'] : undefined;
  const tools = isRecord(result) ? result['tools'] : undefined;
  return Array.isArray(tools) ? tools : null;
}

/** True for a JSON-RPC error with no result beside it: the server refused the request. */
function isRefusal(body: unknown): boolean {
  return isRecord(body) && isRecord(body['error']) && !('result' in body);
}

function describe(answer: Answer): string {
  const body = answer.body === undefined ? 'no JSON body' : JSON.stringify(answer.body);
  return `${String(answer.status)} ${body.slice(0, 160)}`;
}

/**
 * `MCP-Protocol-Version` (2026-07-28): the header has to name the version the body names. A
 * request without it, or with another version in it, is refused before any tool runs.
 */
export async function versionHeaderRows(
  endpoint: URL,
  fetchImpl: Fetch = fetch,
): Promise<CheckRow[]> {
  const group = 'version header';
  const header = 'mcp-protocol-version';

  const matching = await pageToolsList(endpoint, fetchImpl);
  const tools = listedTools(matching.body);
  const rows: CheckRow[] = [
    matching.status === 200 && tools !== null && tools.length > 0
      ? {
          group,
          check: 'matching',
          status: 'pass',
          detail: `${PAGE_PROTOCOL_VERSION}: 200, ${String(tools.length)} tools`,
        }
      : { group, check: 'matching', status: 'fail', detail: describe(matching) },
  ];

  const refusals: [check: string, sent: string | null, label: string][] = [
    ['absent', null, 'no header'],
    ['mismatch', '2025-11-25', 'header 2025-11-25, body 2026-07-28'],
  ];
  for (const [check, sent, label] of refusals) {
    const answer = await pageToolsList(endpoint, fetchImpl, { [header]: sent });
    const refused = answer.status === 400 && isRefusal(answer.body);
    rows.push({
      group,
      check,
      status: refused ? 'pass' : 'fail',
      detail: refused ? `${label}: 400 with a JSON-RPC error` : `${label}: ${describe(answer)}`,
    });
  }
  return rows;
}

/** A browser Origin that is not the site is refused; the site's own pages are served. */
export async function originRows(
  endpoint: URL,
  site: string,
  fetchImpl: Fetch = fetch,
): Promise<CheckRow[]> {
  const group = 'origin';
  const foreign = await pageToolsList(endpoint, fetchImpl, { origin: 'https://evil.example' });
  const own = await pageToolsList(endpoint, fetchImpl, { origin: site });
  return [
    {
      group,
      check: 'foreign',
      status: foreign.status === 403 ? 'pass' : 'fail',
      detail:
        foreign.status === 403
          ? 'Origin https://evil.example: 403'
          : `Origin https://evil.example: ${describe(foreign)}`,
    },
    {
      group,
      check: 'site',
      status: own.status === 200 && listedTools(own.body) !== null ? 'pass' : 'fail',
      detail:
        own.status === 200 && listedTools(own.body) !== null
          ? `Origin ${site}: 200`
          : `Origin ${site}: ${describe(own)}`,
    },
  ];
}

export interface RateLimitOptions {
  /** True when the target is a local stack; the burst is never sent anywhere else. */
  local: boolean;
  /** The made-up client address whose budget the burst spends (`cf-connecting-ip`). */
  key: string;
  /** A second made-up address, which must still be served afterwards. */
  otherKey: string;
  /** A third, for the one repeat of a burst that crossed a minute boundary. */
  retryKey: string;
  /** The clock, for the tests. */
  now?: () => number;
}

/**
 * The per-client budget: 100 requests a minute, the 101st a 429 that says how long to wait,
 * other clients unaffected, healthz never counted. At the edge Cloudflare sets
 * `cf-connecting-ip` itself, so a burst there would spend the runner's own budget and starve
 * the checks after it; the group is skipped unless the stack is local.
 */
export async function rateLimitRows(
  endpoint: URL,
  options: RateLimitOptions,
  fetchImpl: Fetch = fetch,
): Promise<CheckRow[]> {
  const group = 'rate limit';
  if (!options.local) {
    return [
      {
        group,
        check: 'burst',
        status: 'skip',
        detail: 'not a local stack: a burst here would spend this address’s real budget',
      },
    ];
  }
  const card = `${endpoint.href}/server-card`;
  const get = async (url: string, key: string) => {
    const response = await fetchImpl(url, { headers: { 'cf-connecting-ip': key } });
    await response.body?.cancel();
    return response;
  };

  // Local workerd counts in windows aligned to the wall clock, so a burst is only evidence when
  // its first and its 101st request fall in the same window.
  const now = options.now ?? Date.now;
  const windowNow = () => Math.floor(now() / (RATE_LIMIT_PERIOD_SECONDS * 1000));
  const burst = async (key: string) => {
    const started = windowNow();
    let early: string | undefined;
    for (let n = 1; n <= RATE_LIMIT_PER_PERIOD; n++) {
      const response = await get(card, key);
      if (response.status !== 200 && early === undefined) {
        early = `request ${String(n)} of ${String(RATE_LIMIT_PER_PERIOD)} answered ${String(response.status)}`;
      }
    }
    const over = await get(card, key);
    return { key, early, over, crossed: windowNow() !== started };
  };
  let spent = await burst(options.key);
  let note = '';
  if (spent.crossed) {
    spent = await burst(options.retryKey);
    note = spent.crossed
      ? ' (the burst crossed a minute boundary twice, so the count was reset under it)'
      : ' (second burst: the first crossed a minute boundary)';
  }

  const rows: CheckRow[] = [];
  rows.push({
    group,
    check: 'budget',
    status: spent.early === undefined ? 'pass' : 'fail',
    detail:
      (spent.early ?? `${String(RATE_LIMIT_PER_PERIOD)} requests from one client, all 200`) + note,
  });

  const wait = spent.over.headers.get('retry-after');
  const refused = spent.over.status === 429 && wait === String(RATE_LIMIT_PERIOD_SECONDS);
  rows.push({
    group,
    check: 'refusal',
    status: refused ? 'pass' : 'fail',
    detail: `request ${String(RATE_LIMIT_PER_PERIOD + 1)}: ${String(spent.over.status)}, Retry-After ${wait ?? 'absent'}${note}`,
  });

  const other = await get(card, options.otherKey);
  rows.push({
    group,
    check: 'per client',
    status: other.status === 200 ? 'pass' : 'fail',
    detail: `another client, same minute: ${String(other.status)}`,
  });

  const health = await get(`${endpoint.href}/healthz`, spent.key);
  rows.push({
    group,
    check: 'healthz',
    status: health.status === 200 ? 'pass' : 'fail',
    detail: `healthz for the client that is over its budget: ${String(health.status)}`,
  });
  return rows;
}

/**
 * A 2025-11-25 client, the SDK v1 package itself rather than the v2 client's legacy mode:
 * the handshake, the same tool list, and one call.
 */
export async function legacyClientRows(
  endpoint: URL,
  fetchImpl: Fetch = fetch,
): Promise<CheckRow[]> {
  const group = 'legacy client';
  const client = new ClientV1({ name: 'the40thieves-conformance-v1', version: '1.0.0' });
  await client.connect(new TransportV1(endpoint, { fetch: fetchImpl }));
  try {
    const server = client.getServerVersion();
    const rows: CheckRow[] = [
      {
        group,
        check: 'connect',
        status: server === undefined ? 'fail' : 'pass',
        detail:
          server === undefined
            ? 'the 2025-11-25 handshake returned no server info'
            : `2025-11-25 handshake with ${server.name} ${server.version}`,
      },
    ];

    const names = (await client.listTools()).tools.map((tool) => tool.name);
    const same = JSON.stringify(names) === JSON.stringify(MCP_TOOL_NAMES);
    rows.push({
      group,
      check: 'tools/list',
      status: same ? 'pass' : 'fail',
      detail: same
        ? `${String(names.length)} tools, the manifest list`
        : `got ${names.join(', ')}; the manifest says ${MCP_TOOL_NAMES.join(', ')}`,
    });

    const reply = await client.callTool({
      name: 'search_projects',
      arguments: SAMPLE_CALLS['search_projects'] ?? {},
    });
    const answered = reply.isError !== true && isRecord(reply.structuredContent);
    rows.push({
      group,
      check: 'tools/call',
      status: answered ? 'pass' : 'fail',
      detail: answered
        ? 'search_projects answered with structured content'
        : `search_projects: ${JSON.stringify(reply).slice(0, 160)}`,
    });
    return rows;
  } finally {
    await client.close();
  }
}

/** The manifest the stack serves: what every other surface is compared with. */
export async function loadManifest(base: URL, fetchImpl: Fetch = fetch): Promise<Manifest> {
  const response = await fetchImpl(`${base.origin}/manifest.json`);
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`/manifest.json answered ${String(response.status)}`);
  }
  const body: unknown = await response.json();
  return manifestSchema.parse(body);
}

/** One fetched document: how it was answered and what it says. */
export interface Fetched {
  status: number;
  /** The `Content-Type` header, or an empty string. */
  type: string;
  text: string;
  /** The `Link` header of the first answer (before any redirect), or null. */
  link: string | null;
  bytes: number;
}

/** Everything the hub serves for agents, fetched once: keyed by site path. */
export interface Surfaces {
  /** Every page in `manifest.pages`. */
  pages: Map<string, Fetched>;
  /** The Markdown twin of every page, keyed by twin path (`/codecalc.md`). */
  twins: Map<string, Fetched>;
  llmsTxt: Fetched;
  llmsFull: Fetched;
  agents: Fetched;
}

/**
 * Fetch one path. A redirect is followed once and by hand: the `Link` header that names the
 * twin belongs to the path that was asked for (`/404/` answers a 307 to `/404`), the document
 * to where it leads.
 */
async function fetchDocument(base: URL, path: string, fetchImpl: Fetch): Promise<Fetched> {
  const first = await fetchImpl(`${base.origin}${path}`, { redirect: 'manual' });
  const link = first.headers.get('link');
  const location = first.headers.get('location');
  let response = first;
  if (first.status >= 300 && first.status < 400 && location !== null) {
    await first.body?.cancel();
    response = await fetchImpl(new URL(location, `${base.origin}${path}`).href, {
      redirect: 'manual',
    });
  }
  const body = new Uint8Array(await response.arrayBuffer());
  return {
    status: response.status,
    type: response.headers.get('content-type') ?? '',
    text: new TextDecoder().decode(body),
    link,
    bytes: body.byteLength,
  };
}

export async function fetchSurfaces(
  base: URL,
  manifest: Manifest,
  fetchImpl: Fetch = fetch,
): Promise<Surfaces> {
  const pages = new Map<string, Fetched>();
  const twins = new Map<string, Fetched>();
  for (const page of manifest.pages) {
    pages.set(page, await fetchDocument(base, page, fetchImpl));
    const twin = twinPath(page);
    twins.set(twin, await fetchDocument(base, twin, fetchImpl));
  }
  return {
    pages,
    twins,
    llmsTxt: await fetchDocument(base, '/llms.txt', fetchImpl),
    llmsFull: await fetchDocument(base, '/llms-full.txt', fetchImpl),
    agents: await fetchDocument(base, '/AGENTS.md', fetchImpl),
  };
}

const MARKDOWN = 'text/markdown; charset=utf-8';
/** P3-S2 acceptance: `llms-full.txt` stays under 1 MB. */
export const MAX_LLMS_FULL_BYTES = 1_000_000;

function seen(document: Fetched): string {
  return `${String(document.status)} ${document.type === '' ? 'no content type' : document.type}`;
}

/**
 * The agent-readable twins (P3-S2) as they are served: every page answers HTML with a
 * `Link` header to its twin, every twin answers Markdown, and the three index documents answer
 * as text. A 200 is not enough: the hub's own 404 page is HTML, so the type is the check.
 */
export function twinRows(manifest: Manifest, surfaces: Surfaces): CheckRow[] {
  const group = 'twins';
  const rows: CheckRow[] = [];
  const row = (check: string, problem: string | null, fine: string) => {
    rows.push({
      group,
      check,
      status: problem === null ? 'pass' : 'fail',
      detail: problem ?? fine,
    });
  };
  const missing: Fetched = { status: 0, type: '', text: '', link: null, bytes: 0 };

  for (const page of manifest.pages) {
    const twin = twinPath(page);
    const html = surfaces.pages.get(page) ?? missing;
    const wanted = `<${twin}>; rel="alternate"; type="text/markdown"`;
    row(
      page,
      html.status !== 200 || !html.type.startsWith('text/html')
        ? `answered ${seen(html)}, expected 200 text/html`
        : html.link !== wanted
          ? `Link header is ${html.link ?? 'absent'}, expected ${wanted}`
          : null,
      `200 text/html, Link to ${twin}`,
    );
    const markdown = surfaces.twins.get(twin) ?? missing;
    row(
      twin,
      markdown.status !== 200 || markdown.type !== MARKDOWN
        ? `answered ${seen(markdown)}, expected 200 ${MARKDOWN}`
        : null,
      `200 ${MARKDOWN}, ${String(markdown.bytes)} bytes`,
    );
  }

  const { llmsTxt, llmsFull, agents } = surfaces;
  row(
    '/llms.txt',
    llmsTxt.status !== 200 || !llmsTxt.type.startsWith('text/plain')
      ? `answered ${seen(llmsTxt)}, expected 200 text/plain`
      : null,
    `200 text/plain, ${String(llmsTxt.bytes)} bytes`,
  );
  row(
    '/llms-full.txt',
    llmsFull.status !== 200 || !llmsFull.type.startsWith('text/plain')
      ? `answered ${seen(llmsFull)}, expected 200 text/plain`
      : llmsFull.bytes >= MAX_LLMS_FULL_BYTES
        ? `${String(llmsFull.bytes)} bytes, the limit is ${String(MAX_LLMS_FULL_BYTES)}`
        : null,
    `200 text/plain, ${String(llmsFull.bytes)} bytes`,
  );
  row(
    '/AGENTS.md',
    agents.status !== 200 || agents.type !== MARKDOWN
      ? `answered ${seen(agents)}, expected 200 ${MARKDOWN}`
      : null,
    `200 ${MARKDOWN}, ${String(agents.bytes)} bytes`,
  );
  return rows;
}

/** What the `mcp` Worker said at runtime, for the two surfaces it owns. */
export interface ServedTools {
  /** The names in `tools/list`. */
  mcpTools: readonly string[];
  /** The names `/mcp/webmcp` answers, or null while the kill switch is on. */
  webmcpServed: readonly string[] | null;
}

/**
 * The tool names `/mcp/webmcp` answers, in its order, or null while the kill switch is on.
 * Anything that is not that answer throws: there is nothing to hold against the manifest then.
 */
export async function servedPageTools(
  base: URL,
  fetchImpl: Fetch = fetch,
): Promise<string[] | null> {
  const response = await fetchImpl(`${base.origin}${WEBMCP_PATH}`);
  if (response.status !== 200) {
    throw new Error(`${WEBMCP_PATH} answered ${String(response.status)}`);
  }
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body['enabled'] !== 'boolean' || !Array.isArray(body['tools'])) {
    throw new Error(`${WEBMCP_PATH}: the body is not { enabled, tools }`);
  }
  if (!body['enabled']) return null;
  return body['tools'].filter(isRecord).map((tool) => String(tool['name']));
}

/**
 * The manifest contract over HTTP: the same `checkSurfaces` the build output
 * is held to, fed with what the stack serves. Every violation is a row; none is one passing row.
 */
export function driftRows(manifest: Manifest, surfaces: Surfaces, served: ServedTools): CheckRow[] {
  const group = 'drift';
  const answered = (documents: Map<string, Fetched>) =>
    new Map(
      [...documents]
        .filter(([, document]) => document.status === 200)
        .map(([path, document]) => [path, document.text]),
    );
  const pages = answered(surfaces.pages);
  const twins = answered(surfaces.twins);
  const inputs: SurfaceInputs = {
    pages,
    llmsTxt: surfaces.llmsTxt.status === 200 ? surfaces.llmsTxt.text : null,
    twins,
    jsonLd: new Map([...pages].map(([path, html]) => [path, jsonLdBlocks(html)])),
    mcpTools: served.mcpTools,
    webmcp: new Map([...pages].map(([path, html]) => [path, pageDeclaredTools(html)])),
    ...(served.webmcpServed === null ? {} : { webmcpServed: served.webmcpServed }),
  };
  const violations = checkSurfaces(manifest, inputs);
  if (violations.length === 0) {
    const pageTools =
      served.webmcpServed === null
        ? 'page tools off'
        : `${String(served.webmcpServed.length)} page tools`;
    return [
      {
        group,
        check: 'manifest contract',
        status: 'pass',
        detail: `${String(pages.size)} pages, ${String(twins.size)} twins, llms.txt, ${String(served.mcpTools.length)} MCP tools and ${pageTools}: all inside the manifest`,
      },
    ];
  }
  return violations.map((violation) => ({
    group,
    check: violation.surface,
    status: 'fail' as const,
    detail: `${violation.where}: ${violation.detail}`,
  }));
}
